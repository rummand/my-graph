/** GitHub's REST answers in My Graph's work-batch shape (pure). */
import type { WorkItem, WorkPerson } from "@/lib/importers/github/work";
import { dayOf, isoOf, plainBody } from "./work";

export type GhUser = { login: string; id?: number; type?: string; name?: string | null; email?: string | null; html_url?: string };
export type GhLabel = string | { name?: string };
export type GhMilestone = { id: number; number?: number; title: string; state: "open" | "closed"; description?: string | null; due_on?: string | null; updated_at?: string; closed_at?: string | null; html_url?: string };
export type GhIssue = {
  id: number; number: number; title: string; state: "open" | "closed"; state_reason?: string | null; html_url?: string; body?: string | null;
  user?: GhUser | null; assignees?: GhUser[] | null; assignee?: GhUser | null; labels?: GhLabel[]; milestone?: GhMilestone | null;
  created_at?: string; updated_at: string; closed_at?: string | null;
  pull_request?: { merged_at?: string | null; html_url?: string } | null;
  draft?: boolean;
};
export type GhRepo = { id: number; name: string; full_name: string; html_url?: string; description?: string | null; archived?: boolean; fork?: boolean; pushed_at?: string | null; owner?: GhUser };
export type GhRelease = { id: number; name?: string | null; tag_name: string; html_url?: string; body?: string | null; draft?: boolean; prerelease?: boolean; published_at?: string | null; created_at?: string };

/** "owner/name" from what a person typed: the name itself, a github.com address, or a clone address. */
export function repoName(raw: string): string | null {
  const t = raw.trim().replace(/^https?:\/\/(www\.)?github\.com\//i, "").replace(/^git@github\.com:/i, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  const m = t.match(/^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100})$/);
  return m && m[2] !== "." && m[2] !== ".." ? `${m[1]}/${m[2]}` : null;
}

export const isBot = (u: GhUser | null | undefined) => !!u && (u.type === "Bot" || /\[bot\]$/i.test(u.login));

export function ghPerson(u: GhUser): WorkPerson {
  return {
    id: u.login, login: u.login, ...(u.name ? { name: u.name } : {}), ...(u.email ? { email: u.email } : {}),
    ...(u.html_url ? { url: u.html_url } : {}), ...(isBot(u) ? { bot: true } : {}),
  };
}

const labelName = (l: GhLabel) => (typeof l === "string" ? l : l.name ?? "").trim();

export function ghItem(i: GhIssue): WorkItem {
  const pr = !!i.pull_request;
  const merged = pr && !!i.pull_request?.merged_at;
  const cancelled = i.state === "closed" && (i.state_reason === "not_planned" || (pr && !merged));
  const state = merged ? "merged" : i.state === "closed" ? (i.state_reason === "not_planned" ? "closed as not planned" : "closed") : pr && i.draft ? "draft" : "open";
  const assignees = (i.assignees?.length ? i.assignees : i.assignee ? [i.assignee] : []).map((a) => a.login);
  return {
    id: String(i.id), key: `#${i.number}`, kind: pr ? "pull_request" : "issue", title: i.title.slice(0, 500), url: i.html_url,
    state, status: i.state === "open" ? "open" : cancelled ? "cancelled" : "done",
    authorId: i.user?.login, assigneeIds: [...new Set(assignees)].slice(0, 20),
    labels: (i.labels ?? []).map(labelName).filter(Boolean).slice(0, 30),
    ...(i.milestone ? { milestone: { name: i.milestone.title.slice(0, 200), ...(dayOf(i.milestone.due_on) ? { dueOn: dayOf(i.milestone.due_on) } : {}) } } : {}),
    createdAt: isoOf(i.created_at), updatedAt: isoOf(i.updated_at)!, closedAt: isoOf(i.closed_at), mergedAt: isoOf(i.pull_request?.merged_at),
    body: plainBody(i.body),
  };
}

/** Everyone the issues name (authors and assignees), once each. */
export function ghPeople(issues: GhIssue[]): Map<string, GhUser> {
  const out = new Map<string, GhUser>();
  for (const i of issues) for (const u of [i.user, i.assignee, ...(i.assignees ?? [])]) if (u?.login && !out.has(u.login)) out.set(u.login, u);
  return out;
}

export function ghMilestone(m: GhMilestone) {
  return {
    id: String(m.id), name: m.title.slice(0, 300), status: m.state === "open" ? ("open" as const) : ("done" as const),
    ...(dayOf(m.due_on) ? { dueOn: dayOf(m.due_on) } : {}), ...(m.html_url ? { url: m.html_url } : {}), ...(plainBody(m.description) ? { description: plainBody(m.description) } : {}),
  };
}

export function ghRelease(r: GhRelease) {
  return {
    id: String(r.id), name: (r.name?.trim() || r.tag_name).slice(0, 300), tag: r.tag_name.slice(0, 200), at: isoOf(r.published_at ?? r.created_at)!,
    ...(r.html_url ? { url: r.html_url } : {}), ...(plainBody(r.body) ? { body: plainBody(r.body) } : {}),
  };
}
