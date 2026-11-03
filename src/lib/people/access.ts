/**
 * Local visibility rules (mirrors CLAUDE.md / schema.ts and gbrain/access.ts):
 *   only items in the viewer's current graph, and within it:
 *   owner            → always
 *   household        → everyone in the graph (not guests)
 *   parents          → owner + owner/parent roles (in a non-family graph: owner + editors)
 *   private          → owner only
 *   explicit share   → the shared user (until it expires)
 *   children never see sensitive items they don't own.
 * Roles and household come from the viewer's graph scope (lib/graphs/pure.ts).
 */
import { and, eq, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { shares } from "@/db/schema";
import { sameGraph, scopeOf, type ScopeInput } from "@/lib/graphs/pure";

export type Visibility = "private" | "parents" | "household";
export type AccessItem = { ownerId: string; householdId?: string; visibility: Visibility; sensitive?: boolean; graphId?: string | null };

/** Owner or parent by the viewer's effective role in their current graph. */
export const isParentRole = (v: ScopeInput) => {
  const r = scopeOf(v).role;
  return r === "owner" || r === "parent";
};

/** Pure predicate. `shared` = the item was explicitly shared to the viewer (unexpired). */
export function canSee(v: ScopeInput, item: AccessItem, shared = false): boolean {
  const s = scopeOf(v);
  if (item.graphId !== undefined && !sameGraph(s, item.graphId)) return false;
  if (item.ownerId === s.id) return true;
  if (item.householdId && item.householdId !== s.householdId) return false;
  if (item.sensitive && s.role === "child") return false;
  if (shared) return true;
  if (s.role === "guest") return false;
  if (item.visibility === "household") return true;
  if (item.visibility === "parents") return isParentRole(s);
  return false;
}

/** May the viewer edit this node? Owner, or an explicit edit share (children never for sensitive items) — same as gbrain. */
export function canModify(v: ScopeInput, item: AccessItem, sharedEdit = false): boolean {
  const s = scopeOf(v);
  if (!s.canWrite && s.role !== "guest") return false;
  if (item.graphId !== undefined && !sameGraph(s, item.graphId)) return false;
  if (item.ownerId === s.id) return s.role !== "guest" || sharedEdit;
  if (item.householdId && item.householdId !== s.householdId) return false;
  return sharedEdit && (s.role !== "child" || !item.sensitive);
}

/** SQL version of `canSee` for a table with graph_id / owner_id / household_id / visibility / sensitive columns. */
export function visibleWhere(v: ScopeInput,
  t: { ownerId: AnyPgColumn; householdId: AnyPgColumn; graphId: AnyPgColumn; visibility: AnyPgColumn; sensitive?: AnyPgColumn; id?: AnyPgColumn }): SQL {
  const s = scopeOf(v);
  const roleVis: SQL[] = [];
  if (s.role !== "guest") roleVis.push(eq(t.visibility, "household"));
  if (isParentRole(s)) roleVis.push(eq(t.visibility, "parents"));
  const sharedTo = t.id
    ? sql`exists (select 1 from ${shares} where ${shares.nodeId} = ${t.id} and ${shares.userId} = ${s.id} and (${shares.expiresAt} is null or ${shares.expiresAt} > now()))`
    : undefined;
  const others = or(...roleVis, ...(sharedTo ? [sharedTo] : []));
  const notSensitiveForChild = s.role === "child" && t.sensitive ? eq(t.sensitive, false) : undefined;
  const graph = s.graphId ? eq(t.graphId, s.graphId) : sql`true`;
  return and(graph, or(
    eq(t.ownerId, s.id),
    others ? and(eq(t.householdId, s.householdId), others, notSensitiveForChild) : sql`false`,
  ))!;
}
