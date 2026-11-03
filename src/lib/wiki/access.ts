/**
 * Who may read, edit and delete a wiki page. Same visibility rules as the graph, checked locally so wiki reads don't
 * depend on GBrain internals. Pure functions + one SQL fragment that mirrors canReadPage.
 *
 *   private   ("Only me")     — the owner only
 *   parents   ("Parents")     — the owner and every owner/parent in the household (children never)
 *   household ("Whole family")— everyone in the household
 * Guests don't see wiki pages (they only see graph items shared with them explicitly).
 *
 * Editing: the owner, plus anyone who can read a shared page (household or parents), except guests.
 * Deleting: the owner, or a parent for a whole-family page. Changing who can see it: the owner only.
 */
import { sql, type SQL } from "drizzle-orm";

export type Role = "owner" | "parent" | "child" | "guest";
import type { Visibility } from "./labels";
export type { Visibility };

export type PageViewer = { id: string; householdId: string; role: Role };
export type PageAccessItem = { ownerId: string; householdId: string; visibility: Visibility };

export const isParentRole = (r: Role) => r === "owner" || r === "parent";

export function canReadPage(v: PageViewer, p: PageAccessItem): boolean {
  if (v.role === "guest") return false;
  if (p.householdId !== v.householdId) return false;
  if (p.ownerId === v.id) return true;
  if (p.visibility === "household") return true;
  if (p.visibility === "parents") return isParentRole(v.role);
  return false;
}

export function canEditPage(v: PageViewer, p: PageAccessItem): boolean {
  if (!canReadPage(v, p)) return false;
  return p.ownerId === v.id || p.visibility !== "private";
}

export function canDeletePage(v: PageViewer, p: PageAccessItem): boolean {
  if (!canReadPage(v, p)) return false;
  return p.ownerId === v.id || (p.visibility === "household" && isParentRole(v.role));
}

export function canChangeVisibility(v: PageViewer, p: PageAccessItem): boolean {
  return canReadPage(v, p) && p.ownerId === v.id;
}

export type PagePermissions = { edit: boolean; delete: boolean; changeVisibility: boolean };

export function pagePermissions(v: PageViewer, p: PageAccessItem): PagePermissions {
  return { edit: canEditPage(v, p), delete: canDeletePage(v, p), changeVisibility: canChangeVisibility(v, p) };
}

/** SQL twin of canReadPage for list queries. `t` is the wiki_pages table alias (default "wiki_pages"). */
export function pageReadSql(v: PageViewer, t = "wiki_pages"): SQL {
  if (v.role === "guest") return sql`false`;
  const col = (c: string) => sql.raw(`"${t}"."${c}"`);
  const parent = isParentRole(v.role);
  return sql`(${col("household_id")} = ${v.householdId} and (
    ${col("owner_id")} = ${v.id}
    or ${col("visibility")} = 'household'
    or (${parent ? sql`true` : sql`false`} and ${col("visibility")} = 'parents')
  ))`;
}

export { VISIBILITY_LABEL, VISIBILITY_HINT } from "./labels";
