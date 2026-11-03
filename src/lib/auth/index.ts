/**
 * Auth contract (owned by the auth workstream). Server-only.
 * Everything that reads data calls `requireUser()` and passes the returned `Viewer` to GBrain, which enforces access.
 */
export type Role = "owner" | "parent" | "child" | "guest";

export type Viewer = {
  id: string;
  householdId: string;
  name: string;
  email: string;
  role: Role;
  personNodeId: string | null;
};

/** The signed-in user, or null. Reads the session cookie. */
export async function getViewer(): Promise<Viewer | null> {
  throw new Error("auth.getViewer not implemented");
}

/** The signed-in user; redirects to /login (pages) or throws a 401 Response (route handlers) when signed out. */
export async function requireUser(): Promise<Viewer> {
  throw new Error("auth.requireUser not implemented");
}

/** Owner or parent. */
export function isParent(v: Viewer): boolean {
  return v.role === "owner" || v.role === "parent";
}

/** Append-only audit entry. */
export async function audit(v: Pick<Viewer, "id" | "householdId"> | null, action: string, target?: { type: string; id: string }, meta: Record<string, unknown> = {}): Promise<void> {
  throw new Error("auth.audit not implemented");
}
