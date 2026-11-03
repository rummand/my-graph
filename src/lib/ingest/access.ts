/**
 * Who may see a source. Mirrors GBrain's visibility rules on the source row itself (sources carry the same
 * ownerId / visibility / sensitive fields as nodes), plus explicit shares of the source's document node.
 *   private   — only the owner (or someone it is shared with)
 *   parents   — owner + owners/parents in the same household
 *   household — everyone in the household except guests; a sensitive source stays parents-only
 * Guests see only what is explicitly shared with them, and nothing once their access has expired (checked by the
 * callers in library.ts via gbrain.accessContext). Children never see someone else's sensitive file.
 */
import { and, eq, or, sql, type SQL } from "drizzle-orm";
import type { Viewer } from "@/lib/auth";
import { sources } from "@/db/schema";

export type SourceAccessFields = { ownerId: string; householdId: string; visibility: "private" | "parents" | "household"; sensitive: boolean };

const isParentRole = (v: Pick<Viewer, "role">) => v.role === "owner" || v.role === "parent";

/** Pure check. `sharedWithViewer` = the source's document node is shared to the viewer (and not expired). */
export function canReadSourceRow(v: Pick<Viewer, "id" | "householdId" | "role">, s: SourceAccessFields, sharedWithViewer = false): boolean {
  if (s.ownerId === v.id) return true;
  // Children never see someone else's sensitive file, not even through a share.
  if (v.role === "child" && s.sensitive) return false;
  if (sharedWithViewer) return true;
  if (s.householdId !== v.householdId || v.role === "guest") return false;
  if (s.visibility === "parents") return isParentRole(v);
  if (s.visibility === "household") return s.sensitive ? isParentRole(v) : true;
  return false;
}

/** Only the owner changes or deletes a source. */
export function canEditSourceRow(v: Pick<Viewer, "id">, s: Pick<SourceAccessFields, "ownerId">): boolean {
  return s.ownerId === v.id;
}

/** The same rule as a SQL predicate over `sources`, for list queries. */
export function sourceVisibleTo(v: Viewer): SQL {
  const sharedAny = sql`${sources.nodeId} in (select node_id from shares where user_id = ${v.id} and (expires_at is null or expires_at > now()))`;
  const shared = v.role === "child" ? and(sharedAny, eq(sources.sensitive, false))! : sharedAny;
  if (v.role === "guest") return or(eq(sources.ownerId, v.id), shared)!;
  const parent = isParentRole(v);
  const household = parent
    ? or(eq(sources.visibility, "household"), eq(sources.visibility, "parents"))!
    : and(eq(sources.visibility, "household"), eq(sources.sensitive, false))!;
  return or(eq(sources.ownerId, v.id), and(eq(sources.householdId, v.householdId), household), shared)!;
}
