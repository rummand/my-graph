/**
 * GBrain access rules. One definition, two forms:
 *  - pure functions (canReadItem / canEditItem / canReadEdgeItem) for single checks and tests;
 *  - SQL fragments (nodeReadSql / edgeReadSql / sourceReadSql) that every query reuses.
 * Keep them in step — access.test.ts covers the pure rules and scripts check the SQL against the same cases.
 *
 * Rules
 *  - Graphs first: an item is only ever visible inside its own graph, to a member working in that graph.
 *    `ctx.graphId` is the viewer's current graph; every rule below is applied within it (see lib/graphs/pure.ts).
 *  - The owner always sees their own items (guests excepted, see below).
 *  - household: everyone in the graph. parents: owner + owners/parents (in a non-family graph: owner + editors).
 *    private: owner only.
 *  - An explicit, non-expired share grants read (and edit when canEdit) — only for an item in the same graph.
 *  - Guests see only items shared with them, and only while their account has not expired.
 *  - Children (and viewers of a non-family graph) never see sensitive items unless they own them.
 *  - Writing needs `ctx.canWrite`: guests never write, and neither do viewers of a non-family graph.
 */
import { sql, type SQL } from "drizzle-orm";
import { scopeOf, type ScopeInput } from "@/lib/graphs/pure";
import type { Vis } from "./pure";

export type Role = "owner" | "parent" | "child" | "guest";

export type AccessCtx = {
  id: string;
  /** The graph's household (the household content rows in this graph carry). */
  householdId: string;
  /** Effective role inside the current graph. */
  role: Role;
  /** For guests: whether users.accessExpiresAt is still in the future. Always true for other roles. */
  active: boolean;
  /** The graph being read. null only for bare unit-test contexts (no graph filter). */
  graphId: string | null;
  /** Whether this person may add to or change the graph at all. */
  canWrite: boolean;
};

export type AccessItem = { ownerId: string; householdId: string; visibility: Vis; sensitive: boolean; graphId?: string | null };
export type ShareGrant = { canEdit: boolean; expiresAt: Date | null };

/** Build the access context for a viewer (or a bare {id, householdId, role} in tests). */
export function ctxFor(v: ScopeInput, active = true): AccessCtx {
  const s = scopeOf(v);
  return { id: s.id, householdId: s.householdId, role: s.role, active, graphId: s.graphId, canWrite: s.canWrite };
}

export function isParentRole(role: Role): boolean {
  return role === "owner" || role === "parent";
}

export function guestActive(accessExpiresAt: Date | null | undefined, now = new Date()): boolean {
  return !!accessExpiresAt && accessExpiresAt.getTime() > now.getTime();
}

export function shareActive(s: ShareGrant, now = new Date()): boolean {
  return s.expiresAt === null || s.expiresAt.getTime() > now.getTime();
}

function inGraph(ctx: Pick<AccessCtx, "graphId">, item: { graphId?: string | null }): boolean {
  if (ctx.graphId === null || ctx.graphId === undefined) return true;
  return item.graphId === ctx.graphId;
}

function childBlocked(ctx: AccessCtx, item: Pick<AccessItem, "ownerId" | "sensitive">): boolean {
  return ctx.role === "child" && item.sensitive && item.ownerId !== ctx.id;
}

/** Visibility rule alone (no shares). */
function visibleByRule(ctx: AccessCtx, item: Omit<AccessItem, "sensitive">): boolean {
  if (!inGraph(ctx, item)) return false;
  if (item.ownerId === ctx.id) return true;
  if (item.householdId !== ctx.householdId) return false;
  if (item.visibility === "household") return true;
  if (item.visibility === "parents") return isParentRole(ctx.role);
  return false;
}

export function canReadItem(ctx: AccessCtx, item: AccessItem, shares: ShareGrant[] = [], now = new Date()): boolean {
  if (!ctx.active) return false;
  if (!inGraph(ctx, item)) return false;
  if (childBlocked(ctx, item)) return false;
  const shared = shares.some((s) => shareActive(s, now));
  if (ctx.role === "guest") return shared;
  return shared || visibleByRule(ctx, item);
}

export function canEditItem(ctx: AccessCtx, item: Pick<AccessItem, "ownerId" | "sensitive" | "graphId">, shares: ShareGrant[] = [], now = new Date()): boolean {
  // Family guests keep their edit shares; a viewer of a non-family graph never edits.
  if (!ctx.active || (!ctx.canWrite && ctx.role !== "guest")) return false;
  if (!inGraph(ctx, item)) return false;
  if (childBlocked(ctx, item)) return false;
  const editShare = shares.some((s) => s.canEdit && shareActive(s, now));
  if (ctx.role === "guest") return editShare;
  return item.ownerId === ctx.id || editShare;
}

/**
 * A fact is visible when the edge itself is (owner / visibility rule, or a share on either end) and both of its
 * endpoints are readable — all three in the viewer's graph.
 */
export function canReadEdgeItem(
  ctx: AccessCtx,
  edge: Omit<AccessItem, "sensitive">,
  from: { item: AccessItem; shares?: ShareGrant[] },
  to: { item: AccessItem; shares?: ShareGrant[] },
  now = new Date(),
): boolean {
  if (!inGraph(ctx, edge)) return false;
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

/** WHERE fragment: the row under `a` is in the viewer's graph. Production contexts always carry a graph. */
export function graphSql(ctx: Pick<AccessCtx, "graphId">, a: SQL): SQL {
  if (ctx.graphId === null || ctx.graphId === undefined) return sql`true`;
  return sql`${a}.graph_id = ${ctx.graphId}`;
}

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
  const g = graphSql(ctx, a);
  const share = shareExistsSql(ctx, sql`${a}.id`);
  const child = ctx.role === "child" ? sql` and (not ${a}.sensitive or ${a}.owner_id = ${ctx.id})` : sql``;
  if (ctx.role === "guest") return sql`(${g} and ${share})`;
  return sql`(${g} and (${ruleSql(ctx, a)} or ${share})${child})`;
}

/** WHERE fragment: the node row under `alias` is editable by the viewer. */
export function nodeEditSql(ctx: AccessCtx, alias = "nodes"): SQL {
  if (!ctx.active || (!ctx.canWrite && ctx.role !== "guest")) return sql`false`;
  const a = ident(alias);
  const g = graphSql(ctx, a);
  const share = shareExistsSql(ctx, sql`${a}.id`, true);
  const child = ctx.role === "child" ? sql` and (not ${a}.sensitive or ${a}.owner_id = ${ctx.id})` : sql``;
  if (ctx.role === "guest") return sql`(${g} and ${share})`;
  return sql`(${g} and (${a}.owner_id = ${ctx.id} or ${share})${child})`;
}

/** WHERE fragment for the edge row itself (combine with nodeReadSql on both endpoints). */
export function edgeSelfReadSql(ctx: AccessCtx, alias = "edges"): SQL {
  if (!ctx.active) return sql`false`;
  const a = ident(alias);
  const g = graphSql(ctx, a);
  const endShared = sql`(${shareExistsSql(ctx, sql`${a}.from_id`)} or ${shareExistsSql(ctx, sql`${a}.to_id`)})`;
  if (ctx.role === "guest") return sql`(${g} and ${endShared})`;
  return sql`(${g} and (${ruleSql(ctx, a)} or ${endShared}))`;
}

/** WHERE fragment: a source (and so its chunks) is readable. Sources are never shared to guests. */
export function sourceReadSql(ctx: AccessCtx, alias = "sources"): SQL {
  if (!ctx.active || ctx.role === "guest") return sql`false`;
  const a = ident(alias);
  const g = graphSql(ctx, a);
  const child = ctx.role === "child" ? sql` and (not ${a}.sensitive or ${a}.owner_id = ${ctx.id})` : sql``;
  return sql`(${g} and ${ruleSql(ctx, a)}${child})`;
}

/** WHERE fragment: the node row under `alias` is not retired (props.retired). Lists use it; reads by id don't. */
export function liveNodeSql(alias = "nodes"): SQL {
  return sql`coalesce(${ident(alias)}.props->>'retired', '') <> 'true'`;
}
