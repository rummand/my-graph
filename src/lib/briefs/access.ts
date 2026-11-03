/**
 * Local access rules for the Today page and reminders (pure; mirrors the visibility rules in schema.ts).
 * GBrain owns the full rules (shares, guest expiry); Today only reads rows it can decide from owner + visibility.
 * Everything is scoped to the viewer's current graph: `scopeOf` gives the graph's household and the role the
 * rules use there (lib/graphs/pure.ts). Items from another graph are never visible.
 */
import { sameGraph, scopeOf, type ScopeInput } from "@/lib/graphs/pure";

type Role = "owner" | "parent" | "child" | "guest";

export const isParentRole = (role: Role) => role === "owner" || role === "parent";

type Item = { ownerId: string; householdId: string; visibility: "private" | "parents" | "household"; sensitive?: boolean; graphId?: string | null };

/**
 * Whether the viewer may see an item from their graph:
 *   owner of the item → yes; children never see someone else's sensitive item; `household` → everyone but guests; `parents` → owners and parents; `private` → owner only.
 */
export function canSeeItem(v: ScopeInput, item: Item): boolean {
  const s = scopeOf(v);
  if (!sameGraph(s, item.graphId)) return false;
  if (item.householdId !== s.householdId) return false;
  if (item.ownerId === s.id) return true;
  // Children never see sensitive items they don't own.
  if (item.sensitive && s.role === "child") return false;
  if (item.visibility === "household") return s.role !== "guest";
  if (item.visibility === "parents") return isParentRole(s.role);
  return false;
}

/** Reminders: the person who owns it, or any parent/owner (editor) in the same graph. Viewers can't change any. */
export function canManageReminder(v: ScopeInput, r: { ownerId: string; householdId: string; graphId?: string | null }): boolean {
  const s = scopeOf(v);
  if (!sameGraph(s, r.graphId)) return false;
  if (r.householdId !== s.householdId) return false;
  if (!s.canWrite) return false;
  return r.ownerId === s.id || isParentRole(s.role);
}

/**
 * Which children a viewer gets a card for: parents see every child, a child sees only themself, guests none.
 * Child cards are a family thing: outside the family graph nobody gets them.
 */
export function visibleChildren<T extends { id: string }>(v: ScopeInput, children: T[]): T[] {
  const s = scopeOf(v);
  if (!s.family) return [];
  if (isParentRole(s.role)) return children;
  if (s.role === "child") return children.filter((c) => c.id === s.id);
  return [];
}
