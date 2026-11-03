/**
 * Local visibility rules (mirrors CLAUDE.md / schema.ts until gbrain.canRead is implemented):
 *   owner            → always
 *   household        → everyone in the household (not guests)
 *   parents          → owner + owner/parent roles
 *   private          → owner only
 *   explicit share   → the shared user (until it expires)
 *   children never see sensitive items they don't own.
 */
import { and, eq, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { shares } from "@/db/schema";
import type { Viewer } from "@/lib/auth";

export type Visibility = "private" | "parents" | "household";
export type AccessItem = { ownerId: string; householdId?: string; visibility: Visibility; sensitive?: boolean };

export const isParentRole = (v: Pick<Viewer, "role">) => v.role === "owner" || v.role === "parent";

/** Pure predicate. `shared` = the item was explicitly shared to the viewer (unexpired). */
export function canSee(v: Pick<Viewer, "id" | "householdId" | "role">, item: AccessItem, shared = false): boolean {
  if (item.ownerId === v.id) return true;
  if (item.householdId && item.householdId !== v.householdId) return false;
  if (item.sensitive && v.role === "child") return false;
  if (shared) return true;
  if (v.role === "guest") return false;
  if (item.visibility === "household") return true;
  if (item.visibility === "parents") return isParentRole(v);
  return false;
}

/** May the viewer edit this node? Owner, or an explicit edit share (children never for sensitive items) — same as gbrain. */
export function canModify(v: Pick<Viewer, "id" | "householdId" | "role">, item: AccessItem, sharedEdit = false): boolean {
  if (item.ownerId === v.id) return v.role !== "guest" || sharedEdit;
  if (item.householdId && item.householdId !== v.householdId) return false;
  return sharedEdit && (v.role !== "child" || !item.sensitive);
}

/** SQL version of `canSee` for a table with owner_id / household_id / visibility / sensitive columns. */
export function visibleWhere(v: Pick<Viewer, "id" | "householdId" | "role">,
  t: { ownerId: AnyPgColumn; householdId: AnyPgColumn; visibility: AnyPgColumn; sensitive?: AnyPgColumn; id?: AnyPgColumn }): SQL {
  const roleVis: SQL[] = [];
  if (v.role !== "guest") roleVis.push(eq(t.visibility, "household"));
  if (isParentRole(v)) roleVis.push(eq(t.visibility, "parents"));
  const sharedTo = t.id
    ? sql`exists (select 1 from ${shares} where ${shares.nodeId} = ${t.id} and ${shares.userId} = ${v.id} and (${shares.expiresAt} is null or ${shares.expiresAt} > now()))`
    : undefined;
  const others = or(...roleVis, ...(sharedTo ? [sharedTo] : []));
  const notSensitiveForChild = v.role === "child" && t.sensitive ? eq(t.sensitive, false) : undefined;
  return or(
    eq(t.ownerId, v.id),
    others ? and(eq(t.householdId, v.householdId), others, notSensitiveForChild) : sql`false`,
  )!;
}
