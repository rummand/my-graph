/** Drizzle conditions mirroring `canSeeItem` (access.ts), so lists are filtered in Postgres. Server-only. */
import { and, eq, or, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { scopeOf, type ScopeInput } from "@/lib/graphs/pure";
import { isParentRole } from "./access";

/**
 * In the viewer's current graph, and: owner, or same household with a visibility the viewer's role may see.
 * Children never see sensitive items they don't own (pass the table's `sensitive` column when it has one).
 * Roles and household come from the viewer's graph scope (see lib/graphs/pure.ts).
 */
export function visibleWhere(
  v: ScopeInput,
  cols: { ownerId: PgColumn; householdId: PgColumn; visibility: PgColumn; graphId: PgColumn; sensitive?: PgColumn },
): SQL {
  const s = scopeOf(v);
  const others: SQL[] = [];
  if (s.role !== "guest") others.push(eq(cols.visibility, "household"));
  if (isParentRole(s.role)) others.push(eq(cols.visibility, "parents"));
  const childBlock = s.role === "child" && cols.sensitive ? eq(cols.sensitive, false) : undefined;
  const othersOk = others.length ? and(or(...others), childBlock) : undefined;
  const graph = s.graphId ? eq(cols.graphId, s.graphId) : sql`true`;
  return and(graph, eq(cols.householdId, s.householdId), othersOk ? or(eq(cols.ownerId, s.id), othersOk) : eq(cols.ownerId, s.id))!;
}

/** Just "in the viewer's current graph" for tables without visibility (reminders). */
export function inGraph(v: ScopeInput, col: PgColumn): SQL {
  const s = scopeOf(v);
  return s.graphId ? eq(col, s.graphId) : sql`false`;
}
