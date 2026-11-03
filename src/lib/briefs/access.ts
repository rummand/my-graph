/**
 * Local access rules for the Today page and reminders (pure; mirrors the visibility rules in schema.ts).
 * GBrain owns the full rules (shares, guest expiry); Today only reads rows it can decide from owner + visibility.
 */
import type { Viewer } from "@/lib/auth";

type Role = Viewer["role"];
type AccessViewer = Pick<Viewer, "id" | "householdId" | "role">;

export const isParentRole = (role: Role) => role === "owner" || role === "parent";

/**
 * Whether the viewer may see an item from their household:
 *   owner of the item → yes; children never see someone else's sensitive item; `household` → everyone but guests; `parents` → owners and parents; `private` → owner only.
 */
export function canSeeItem(v: AccessViewer, item: { ownerId: string; householdId: string; visibility: "private" | "parents" | "household"; sensitive?: boolean }): boolean {
  if (item.householdId !== v.householdId) return false;
  if (item.ownerId === v.id) return true;
  // Children never see sensitive items they don't own.
  if (item.sensitive && v.role === "child") return false;
  if (item.visibility === "household") return v.role !== "guest";
  if (item.visibility === "parents") return isParentRole(v.role);
  return false;
}

/** Reminders: the person who owns it, or any parent/owner in the same household. */
export function canManageReminder(v: AccessViewer, r: { ownerId: string; householdId: string }): boolean {
  if (r.householdId !== v.householdId) return false;
  return r.ownerId === v.id || isParentRole(v.role);
}

/** Which children a viewer gets a card for: parents see every child, a child sees only themself, guests none. */
export function visibleChildren<T extends { id: string }>(v: AccessViewer, children: T[]): T[] {
  if (isParentRole(v.role)) return children;
  if (v.role === "child") return children.filter((c) => c.id === v.id);
  return [];
}
