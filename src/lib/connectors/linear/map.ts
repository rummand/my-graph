/** Linear's GraphQL answers in My Graph's work-batch shape (pure). */
import type { WorkItem, WorkPerson } from "@/lib/importers/github/work";
import { needsYou, willRetry } from "../errors";
import { dayOf, isoOf, plainBody } from "../github/work";

export type LnUser = { id: string; name?: string | null; displayName?: string | null; email?: string | null };
export type LnTeam = { id: string; key: string; name: string; description?: string | null };
export type LnIssue = {
  id: string; identifier: string; title: string; description?: string | null; url?: string | null; priorityLabel?: string | null;
  dueDate?: string | null; createdAt?: string; updatedAt: string; completedAt?: string | null; canceledAt?: string | null;
  state?: { name?: string; type?: string } | null; assignee?: LnUser | null; creator?: LnUser | null;
  labels?: { nodes?: { name: string }[] } | null; project?: { id: string } | null;
  cycle?: { number?: number | null; name?: string | null; startsAt?: string | null; endsAt?: string | null } | null;
};
export type LnProject = {
  id: string; name: string; description?: string | null; url?: string | null; targetDate?: string | null; updatedAt?: string;
  completedAt?: string | null; canceledAt?: string | null; lead?: LnUser | null;
};

export const VIEWER_QUERY = `query MyGraphViewer { viewer { id name displayName email teams(first: 50) { nodes { id key name description } } } }`;

export const ISSUES_QUERY = `query MyGraphIssues($team: String!, $since: DateTimeOrDuration!, $after: String) {
  team(id: $team) {
    issues(first: 50, after: $after, orderBy: updatedAt, filter: { updatedAt: { gt: $since } }) {
      nodes {
        id identifier title description url priorityLabel dueDate createdAt updatedAt completedAt canceledAt
        state { name type } assignee { id name displayName email } creator { id name displayName email }
        labels(first: 20) { nodes { name } } project { id } cycle { number name startsAt endsAt }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

export const PROJECTS_QUERY = `query MyGraphProjects($team: String!) {
  team(id: $team) {
    projects(first: 50) { nodes { id name description url targetDate updatedAt completedAt canceledAt lead { id name displayName email } } }
  }
}`;

export function lnPerson(u: LnUser): WorkPerson {
  const name = u.name?.trim() || undefined;
  const login = u.displayName?.trim() || undefined;
  return { id: u.id, ...(login ? { login } : {}), ...(name ? { name } : {}), ...(u.email ? { email: u.email } : {}) };
}

export function lnItem(i: LnIssue): WorkItem {
  const type = i.state?.type ?? "";
  const status = type === "completed" ? "done" : type === "canceled" ? "cancelled" : "open";
  const c = i.cycle;
  const cycle = c ? `${c.name?.trim() || `Cycle ${c.number ?? ""}`.trim()}${c.startsAt && c.endsAt ? ` (${dayOf(c.startsAt)} to ${dayOf(c.endsAt)})` : ""}` : undefined;
  return {
    id: i.id, key: i.identifier, kind: "issue", title: i.title.slice(0, 500), ...(i.url ? { url: i.url } : {}),
    state: (i.state?.name ?? status).slice(0, 80), status,
    ...(i.creator?.id ? { authorId: i.creator.id } : {}), assigneeIds: i.assignee?.id ? [i.assignee.id] : [],
    labels: (i.labels?.nodes ?? []).map((l) => l.name.trim()).filter(Boolean).slice(0, 30),
    ...(i.project?.id ? { projectId: i.project.id } : {}), ...(cycle ? { cycle: cycle.slice(0, 200) } : {}),
    ...(i.priorityLabel && i.priorityLabel !== "No priority" ? { priority: i.priorityLabel } : {}),
    createdAt: isoOf(i.createdAt), updatedAt: isoOf(i.updatedAt)!, closedAt: isoOf(i.completedAt ?? i.canceledAt),
    ...(dayOf(i.dueDate) ? { dueOn: dayOf(i.dueDate) } : {}), body: plainBody(i.description),
  };
}

/** Everyone the issues name (creators and assignees), once each. */
export function lnPeople(issues: LnIssue[], extra: (LnUser | null | undefined)[] = []): WorkPerson[] {
  const out = new Map<string, WorkPerson>();
  for (const u of [...issues.flatMap((i) => [i.creator, i.assignee]), ...extra]) if (u?.id && !out.has(u.id)) out.set(u.id, lnPerson(u));
  return [...out.values()];
}

/** A project's target date as a milestone, while the project is still going. */
export function lnTarget(p: LnProject) {
  if (!p.targetDate || p.completedAt || p.canceledAt) return null;
  return { id: `target:${p.id}`, name: `${p.name} target date`.slice(0, 300), dueOn: dayOf(p.targetDate), status: "open" as const, ...(p.url ? { url: p.url } : {}) };
}

/** Linear answers problems as GraphQL errors (often HTTP 400): sort them into needs-you and will-retry. */
export function graphqlProblem(status: number, body: { errors?: { message?: string; extensions?: { code?: string; type?: string; userPresentableMessage?: string } }[] } | null): Error | null {
  const errs = body?.errors ?? [];
  if (!errs.length) return status === 200 ? null : needsYou(`Linear answered HTTP ${status}.`, "httpOther");
  const codes = errs.map((e) => `${e.extensions?.code ?? ""} ${e.extensions?.type ?? ""} ${e.message ?? ""}`.toLowerCase()).join(" ");
  if (/ratelimit/.test(codes)) return willRetry("Linear asked us to slow down.", "rateLimited");
  if (/authentication|unauthenticated|not authenticated|invalid api key/.test(codes)) return needsYou("Linear refused the saved key or sign-in. Paste a new key, or sign in again.", "tokenRefused");
  if (/forbidden|not authorized|permission/.test(codes)) return needsYou("Linear says this key or sign-in may not read that.", "forbidden");
  const msg = (errs[0].extensions?.userPresentableMessage ?? errs[0].message ?? "an error").slice(0, 200);
  return needsYou(`Linear couldn't answer: ${msg}`, "httpOther");
}
