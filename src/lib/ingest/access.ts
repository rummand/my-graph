/**
 * Who may see a source. Mirrors GBrain's visibility rules on the source row itself (sources carry the same
 * ownerId / visibility / sensitive fields as nodes), plus explicit shares of the source's document node.
 *   private   — only the owner (or someone it is shared with)
 *   parents   — owner + owners/parents in the same household (in a non-family graph: owner + editors)
 *   household — everyone in the graph except guests; a sensitive source stays parents-only
 * Everything is scoped to the viewer's current graph: a file from another graph is never visible, not even to its
 * owner (switch graphs to see it). Guests see only what is explicitly shared with them, and nothing once their access
 * has expired (checked by the callers in library.ts via gbrain.accessContext). Children never see someone else's
 * sensitive file.
 */
import { and, eq, or, sql, type SQL } from "drizzle-orm";
import { sources } from "@/db/schema";
import { sameGraph, scopeOf, type ScopeInput } from "@/lib/graphs/pure";

export type SourceAccessFields = {
  ownerId: string; householdId: string; visibility: "private" | "parents" | "household"; sensitive: boolean; graphId?: string | null;
};

const isParentRole = (role: string) => role === "owner" || role === "parent";

/** Pure check. `sharedWithViewer` = the source's document node is shared to the viewer (and not expired). */
export function canReadSourceRow(v: ScopeInput, s: SourceAccessFields, sharedWithViewer = false): boolean {
  const sc = scopeOf(v);
  if (!sameGraph(sc, s.graphId)) return false;
  if (s.ownerId === sc.id) return true;
  // Children never see someone else's sensitive file, not even through a share.
  if (sc.role === "child" && s.sensitive) return false;
  if (sharedWithViewer) return true;
  if (s.householdId !== sc.householdId || sc.role === "guest") return false;
  if (s.visibility === "parents") return isParentRole(sc.role);
  if (s.visibility === "household") return s.sensitive ? isParentRole(sc.role) : true;
  return false;
}

/** Only the owner changes or deletes a source, and only while they may write in its graph. */
export function canEditSourceRow(v: ScopeInput, s: Pick<SourceAccessFields, "ownerId" | "graphId">): boolean {
  const sc = scopeOf(v);
  return s.ownerId === sc.id && sameGraph(sc, s.graphId) && sc.canWrite;
}

/** The same rule as a SQL predicate over `sources`, for list queries. */
export function sourceVisibleTo(v: ScopeInput): SQL {
  const sc = scopeOf(v);
  const graph = sc.graphId ? eq(sources.graphId, sc.graphId) : sql`false`;
  const sharedAny = sql`${sources.nodeId} in (select node_id from shares where user_id = ${sc.id} and (expires_at is null or expires_at > now()))`;
  const shared = sc.role === "child" ? and(sharedAny, eq(sources.sensitive, false))! : sharedAny;
  if (sc.role === "guest") return and(graph, or(eq(sources.ownerId, sc.id), shared))!;
  const parent = isParentRole(sc.role);
  const household = parent
    ? or(eq(sources.visibility, "household"), eq(sources.visibility, "parents"))!
    : and(eq(sources.visibility, "household"), eq(sources.sensitive, false))!;
  return and(graph, or(eq(sources.ownerId, sc.id), and(eq(sources.householdId, sc.householdId), household), shared))!;
}
