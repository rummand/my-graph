/**
 * Auth contract (owned by the auth workstream). Server-only.
 * Everything that reads data calls `requireUser()` and passes the returned `Viewer` to GBrain, which enforces access.
 */
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { writeAudit } from "./audit";
import { API_HEADER, PATH_HEADER, SESSION_COOKIE } from "./constants";
import { isWellFormedToken } from "./session";
import { loadSession, type SessionState } from "./store";

export type Role = "owner" | "parent" | "child" | "guest";

export type Viewer = {
  id: string;
  householdId: string;
  name: string;
  email: string;
  role: Role;
  personNodeId: string | null;
};

/** The current request's session, resolved once per request. */
export const getSession = cache(async (): Promise<SessionState> => {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!isWellFormedToken(token)) return { status: "none" };
  return loadSession(token);
});

/** The signed-in user, or null. Reads the session cookie. Sessions waiting for a parent's approval count as signed out. */
export async function getViewer(): Promise<Viewer | null> {
  const s = await getSession();
  return s.status === "active" ? s.viewer : null;
}

function unauthorized(s: SessionState): Response {
  if (s.status === "pending") {
    return Response.json({ error: "A parent needs to approve this device before you can use My Graph here.", pending: true }, { status: 403 });
  }
  const error = s.status === "none" && s.reason === "access_ended" ? "Your guest access has ended." : "Please sign in again.";
  return Response.json({ error }, { status: 401 });
}

/** The signed-in user for route handlers; throws a 401 (or 403 for an unapproved device) JSON Response otherwise. */
export async function requireUserApi(): Promise<Viewer> {
  const s = await getSession();
  if (s.status === "active") return s.viewer;
  throw unauthorized(s);
}

/** The signed-in user; redirects to /login (pages) or throws a 401 Response (route handlers) when signed out. */
export async function requireUser(): Promise<Viewer> {
  const s = await getSession();
  if (s.status === "active") return s.viewer;
  const h = await headers();
  if (h.get(API_HEADER) === "1") throw unauthorized(s);
  if (s.status === "pending") redirect("/login/pending");
  const path = h.get(PATH_HEADER);
  const params = new URLSearchParams();
  if (path && path !== "/") params.set("next", path);
  if (s.status === "none" && s.reason) params.set("reason", s.reason);
  const qs = params.toString();
  redirect(qs ? `/login?${qs}` : "/login");
}

/** Owner or parent. */
export function isParent(v: Viewer): boolean {
  return v.role === "owner" || v.role === "parent";
}

/** A signed-in owner or parent for route handlers; 401/403 JSON Response otherwise. */
export async function requireParentApi(): Promise<Viewer> {
  const v = await requireUserApi();
  if (!isParent(v)) throw Response.json({ error: "Only parents can do this." }, { status: 403 });
  return v;
}

/** Append-only audit entry. */
export async function audit(v: Pick<Viewer, "id" | "householdId"> | null, action: string, target?: { type: string; id: string }, meta: Record<string, unknown> = {}): Promise<void> {
  await writeAudit(v, action, target, meta);
}
