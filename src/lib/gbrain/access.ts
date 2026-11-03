/**
 * GBrain access rules. One definition, two forms:
 *  - pure functions (canReadItem / canEditItem / canReadEdgeItem) for single checks and tests;
 *  - SQL fragments (nodeReadSql / edgeReadSql / sourceReadSql) that every query reuses.
 * Keep them in step — access.test.ts covers the pure rules and scripts check the SQL against the same cases.
 *
 * Rules
 *  - The owner always sees their own items (guests excepted, see below).
 *  - household: everyone in the household. parents: owner + owners/parents of the household. private: owner only.
 *  - An explicit, non-expired share grants read (and edit when canEdit).
 *  - Guests see only items shared with them, and only while their account has not expired.
 *  - Children never see sensitive items unless they own them.
 */
import { sql, type SQL } from "drizzle-orm";
import type { Vis } from "./pure";

export type Role = "owner" | "parent" | "child" | "guest";

export type AccessCtx = {
  id: string;
  householdId: string;
  role: Role;
  /** For guests: whether users.accessExpiresAt is still in the future. Always true for other roles. */
  active: boolean;
};

export type AccessItem = { ownerId: string; householdId: string; visibility: Vis; sensitive: boolean };
export type ShareGrant = { canEdit: boolean; expiresAt: Date | null };

export function isParentRole(role: Role): boolean {
  return role === "owner" || role === "parent";
}

export function guestActive(accessExpiresAt: Date | null | undefined, now = new Date()): boolean {
  return !!accessExpiresAt && accessExpiresAt.getTime() > now.getTime();
}

export function shareActive(s: ShareGrant, now = new Date()): boolean {
  return s.expiresAt === null || s.expiresAt.getTime() > now.getTime();
}

function childBlocked(ctx: AccessCtx, item: Pick<AccessItem, "ownerId" | "sensitive">): boolean {
  return ctx.role === "child" && item.sensitive && item.ownerId !== ctx.id;
}

/** Visibility rule alone (no shares). */
function visibleByRule(ctx: AccessCtx, item: Omit<AccessItem, "sensitive">): boolean {
  if (item.ownerId === ctx.id) return true;
  if (item.householdId !== ctx.householdId) return false;
  if (item.visibility === "household") return true;
  if (item.visibility === "parents") return isParentRole(ctx.role);
  return false;
}

export function canReadItem(ctx: AccessCtx, item: AccessItem, shares: ShareGrant[] = [], now = new Date()): boolean {
  if (!ctx.active) return false;
  if (childBlocked(ctx, item)) return false;
  const shared = shares.some((s) => shareActive(s, now));
  if (ctx.role === "guest") return shared;
  return shared || visibleByRule(ctx, item);
}

export function canEditItem(ctx: AccessCtx, item: Pick<AccessItem, "ownerId" | "sensitive">, shares: ShareGrant[] = [], now = new Date()): boolean {
  if (!ctx.active) return false;
  if (childBlocked(ctx, item)) return false;
  const editShare = shares.some((s) => s.canEdit && shareActive(s, now));
  if (ctx.role === "guest") return editShare;
  return item.ownerId === ctx.id || editShare;
}

/**
 * A fact is visible when the edge itself is (owner / visibility rule, or a share on either end) and both of its
 * endpoints are readable.
 */
export function canReadEdgeItem(
  ctx: AccessCtx,
  edge: Omit<AccessItem, "sensitive">,
  from: { item: AccessItem; shares?: ShareGrant[] },
  to: { item: AccessItem; shares?: ShareGrant[] },
  now = new Date(),
): boolean {
  if (!canReadItem(ctx, from.item, from.shares, now) || !canReadItem(ctx, to.item, to.shares, now)) return false;
  const endShared = [...(from.shares ?? []), ...(to.shares ?? [])].some((s) => shareActive(s, now));
  if (ctx.role === "guest") return endShared;
  return endShared || visibleByRule(ctx, edge);
}

/* ── SQL forms ───────────────────────────────────────────────────────────────────────────────────────── */

const ident = (alias: string) => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error(`bad alias ${alias}`);
  return sql.raw(`"${alias}"`);
};

function shareExistsSql(ctx: AccessCtx, nodeIdCol: SQL, editOnly = false): SQL {
  return sql`exists (select 1 from shares sh where sh.node_id = ${nodeIdCol} and sh.user_id = ${ctx.id}
    and (sh.expires_at is null or sh.expires_at > now())${editOnly ? sql` and sh.can_edit` : sql``})`;
}

function ruleSql(ctx: AccessCtx, a: SQL): SQL {
  const vis = isParentRole(ctx.role) ? sql`${a}.visibility in ('household', 'parents')` : sql`${a}.visibility = 'household'`;
  return sql`(${a}.owner_id = ${ctx.id} or (${a}.household_id = ${ctx.householdId} and ${vis}))`;
}

/** WHERE fragment: the node row under `alias` is readable by the viewer. */
export function nodeReadSql(ctx: AccessCtx, alias = "nodes"): SQL {
  if (!ctx.active) return sql`false`;
  const a = ident(alias);
  const share = shareExistsSql(ctx, sql`${a}.id`);
  const child = ctx.role === "child" ? sql` and (not ${a}.sensitive or ${a}.owner_id = ${ctx.id})` : sql``;
  if (ctx.role === "guest") return sql`(${share})`;
  return sql`((${ruleSql(ctx, a)} or ${share})${child})`;
}

/** WHERE fragment: the node row under `alias` is editable by the viewer. */
export function nodeEditSql(ctx: AccessCtx, alias = "nodes"): SQL {
  if (!ctx.active) return sql`false`;
  const a = ident(alias);
  const share = shareExistsSql(ctx, sql`${a}.id`, true);
  const child = ctx.role === "child" ? sql` and (not ${a}.sensitive or ${a}.owner_id = ${ctx.id})` : sql``;
  if (ctx.role === "guest") return sql`(${share})`;
  return sql`((${a}.owner_id = ${ctx.id} or ${share})${child})`;
}

/** WHERE fragment for the edge row itself (combine with nodeReadSql on both endpoints). */
export function edgeSelfReadSql(ctx: AccessCtx, alias = "edges"): SQL {
  if (!ctx.active) return sql`false`;
  const a = ident(alias);
  const endShared = sql`(${shareExistsSql(ctx, sql`${a}.from_id`)} or ${shareExistsSql(ctx, sql`${a}.to_id`)})`;
  if (ctx.role === "guest") return endShared;
  return sql`(${ruleSql(ctx, a)} or ${endShared})`;
}

/** WHERE fragment: a source (and so its chunks) is readable. Sources are never shared to guests. */
export function sourceReadSql(ctx: AccessCtx, alias = "sources"): SQL {
  if (!ctx.active || ctx.role === "guest") return sql`false`;
  const a = ident(alias);
  const child = ctx.role === "child" ? sql` and (not ${a}.sensitive or ${a}.owner_id = ${ctx.id})` : sql``;
  return sql`(${ruleSql(ctx, a)}${child})`;
}
