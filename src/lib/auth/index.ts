/**
 * Auth contract (owned by the auth workstream). Server-only.
 * Everything that reads data calls `requireUser()` and passes the returned `Viewer` to GBrain, which enforces access.
 */
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { LOCKED_MESSAGE } from "./account-controls";
import { writeAudit } from "./audit";
import { auditIsGraphScoped } from "./audit-labels";
import { API_HEADER, PATH_HEADER, SESSION_COOKIE } from "./constants";
import { isWellFormedToken } from "./session";
import { loadSession, type SessionState as StoredSession, type ViewerRow } from "./store";
import { GRAPH_COOKIE, type GraphContext } from "@/lib/graphs/pure";
import { resolveGraph, selfNodeIn } from "@/lib/graphs/store";

export type Role = "owner" | "parent" | "child" | "guest";

/**
 * The signed-in person, working in one graph. `householdId` and `role` are their own household and household role
 * (settings, members, audit). Content is scoped by the graph fields: `graphId` is the graph they are working in
 * (mg_graph cookie, validated against membership on every request), `graphRole` what they may do there.
 * `personNodeId` is their own person node in the current graph (their "self" node, see src/lib/graphs/self): every
 * member of every graph is a person in it. In their family graph it is `users.personNodeId`; settings and the profile
 * read that from the users row. Null only if the node couldn't be made.
 */
export type Viewer = {
  id: string;
  householdId: string;
  name: string;
  email: string;
  role: Role;
  personNodeId: string | null;
} & GraphContext;

export type SessionState =
  | { status: "none"; reason?: "expired" | "access_ended" | "locked" }
  | { status: "pending"; sessionId: string; viewer: ViewerRow }
  /** `mustChangePassword`: signed in with a temporary password an admin set; pages send them to choose a new one. */
  | { status: "active"; sessionId: string; viewer: Viewer; mustChangePassword?: boolean };

/** Attach the working graph to a signed-in user (the requested one when they are a member, else their default). */
export async function withGraph(row: ViewerRow, requested: string | null | undefined): Promise<Viewer | null> {
  const g = await resolveGraph(row, requested);
  if (!g) return null;
  return { ...row, personNodeId: await selfNodeIn(row, g, { personNodeIdIsHome: true }), ...g };
}

/** Where someone signed in with a temporary password is sent to choose their own. */
export const MUST_CHANGE_PATH = "/settings?mustChange=1#password";

/** The current request's session, resolved once per request. */
export const getSession = cache(async (): Promise<SessionState> => {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!isWellFormedToken(token)) return { status: "none" };
  const s: StoredSession = await loadSession(token);
  if (s.status !== "active") return s;
  const viewer = await withGraph(s.viewer, jar.get(GRAPH_COOKIE)?.value ?? null);
  if (!viewer) return { status: "none" };
  return { status: "active", sessionId: s.sessionId, viewer, mustChangePassword: s.mustChangePassword };
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
  const error = s.status === "none" && s.reason === "access_ended" ? "Your guest access has ended."
    : s.status === "none" && s.reason === "locked" ? LOCKED_MESSAGE : "Please sign in again.";
  return Response.json({ error }, { status: 401 });
}

/** API calls with a temporary password: only signing in/out, settings and choosing a new password work until it's replaced. */
async function refuseUntilPasswordChanged(): Promise<void> {
  const path = (await headers()).get(PATH_HEADER) ?? "";
  if (path.startsWith("/api/auth/") || path.startsWith("/api/settings")) return;
  throw Response.json({ error: "Choose a new password in Settings before you go on.", mustChangePassword: true }, { status: 403 });
}

/** The signed-in user for route handlers; throws a 401 (or 403 for an unapproved device) JSON Response otherwise. */
export async function requireUserApi(): Promise<Viewer> {
  const s = await getSession();
  if (s.status === "active") {
    if (s.mustChangePassword) await refuseUntilPasswordChanged();
    return s.viewer;
  }
  throw unauthorized(s);
}

/** The signed-in user; redirects to /login (pages) or throws a 401 Response (route handlers) when signed out. */
export async function requireUser(): Promise<Viewer> {
  const s = await getSession();
  if (s.status === "active") {
    // A temporary password from an admin has to be replaced before anything else (settings is where you do that).
    if (s.mustChangePassword) {
      const h = await headers();
      const path = h.get(PATH_HEADER) ?? "";
      if (h.get(API_HEADER) === "1") await refuseUntilPasswordChanged();
      else if (!path.startsWith("/settings")) redirect(MUST_CHANGE_PATH);
    }
    return s.viewer;
  }
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
  // Content actions remember the graph they happened in, so the household's activity log can keep another
  // graph's activity (a Work file, a page in a graph shared with someone else) away from the rest of the family.
  const graphId = v ? (v as { graphId?: unknown }).graphId : undefined;
  const tagged = typeof graphId === "string" && auditIsGraphScoped(action) && meta.graphId === undefined ? { ...meta, graphId } : meta;
  await writeAudit(v, action, target, tagged);
}
