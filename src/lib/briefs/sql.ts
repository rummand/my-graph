/** Drizzle conditions mirroring `canSeeItem` (access.ts), so lists are filtered in Postgres. Server-only. */
import { and, eq, or, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { Viewer } from "@/lib/auth";
import { isParentRole } from "./access";

/**
 * Owner, or same household with a visibility the viewer's role may see. Children never see sensitive items they
 * don't own (pass the table's `sensitive` column when it has one).
 */
export function visibleWhere(
  v: Pick<Viewer, "id" | "householdId" | "role">,
  cols: { ownerId: PgColumn; householdId: PgColumn; visibility: PgColumn; sensitive?: PgColumn },
): SQL {
  const others: SQL[] = [];
  if (v.role !== "guest") others.push(eq(cols.visibility, "household"));
  if (isParentRole(v.role)) others.push(eq(cols.visibility, "parents"));
  const childBlock = v.role === "child" && cols.sensitive ? eq(cols.sensitive, false) : undefined;
  const othersOk = others.length ? and(or(...others), childBlock) : undefined;
  return and(eq(cols.householdId, v.householdId), othersOk ? or(eq(cols.ownerId, v.id), othersOk) : eq(cols.ownerId, v.id))!;
}
