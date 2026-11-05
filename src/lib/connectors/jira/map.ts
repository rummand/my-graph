/** Jira Cloud's REST answers in My Graph's work-batch shape (pure). */
import type { WorkItem, WorkPerson } from "@/lib/importers/github/work";
import { needsYou } from "../errors";
import { dayOf, isoOf, plainBody } from "../github/work";

export type JiUser = { accountId: string; displayName?: string | null; emailAddress?: string | null; accountType?: string };
export type JiVersion = { id: string; name: string; released?: boolean; releaseDate?: string | null; description?: string | null; archived?: boolean };
export type JiIssue = {
  id: string; key: string;
  fields: {
    summary?: string; description?: unknown; status?: { name?: string; statusCategory?: { key?: string } } | null;
    assignee?: JiUser | null; reporter?: JiUser | null; creator?: JiUser | null; labels?: string[]; duedate?: string | null;
    created?: string; updated?: string; resolutiondate?: string | null; project?: { id: string; key: string; name: string } | null;
    issuetype?: { name?: string } | null; priority?: { name?: string } | null; fixVersions?: JiVersion[] | null;
    resolution?: { name?: string } | null;
  };
};

export const JIRA_FIELDS = ["summary", "description", "status", "assignee", "reporter", "labels", "duedate", "created", "updated", "resolutiondate", "project", "issuetype", "priority", "fixVersions", "resolution"];

/** The Jira Cloud site as https://<name>.atlassian.net, or null when it isn't one. */
export function jiraSite(raw: string): string | null {
  let u: URL;
  try { u = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,62}\.(atlassian\.net|jira\.com)$/.test(host)) return null;
  return `https://${host}`;
}

/** A project key a person typed, safe to put in JQL (letters, digits, _). */
export function projectKey(raw: string): string | null {
  const k = raw.trim().toUpperCase();
  return /^[A-Z][A-Z0-9_]{0,19}$/.test(k) ? k : null;
}

/** JQL's date: "yyyy-MM-dd HH:mm", in the person's Jira time zone, so reads start a day early and skip what's known. */
export function jqlDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** The JQL for one run: the named projects, else the person's own issues (assigned, reported or watched). */
export function buildJql(projects: string[], from: Date): string {
  const when = `updated >= "${jqlDate(new Date(from.getTime() - 86_400_000))}"`;
  const who = projects.length ? `project in (${projects.map((p) => `"${p}"`).join(", ")})` : "(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser())";
  return `${who} AND ${when} ORDER BY updated DESC`;
}

/** Atlassian Document Format (the description) as plain text. */
export function adfText(node: unknown, depth = 0): string {
  if (depth > 40 || node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map((n) => adfText(n, depth + 1)).join("");
  const n = node as { type?: string; text?: string; content?: unknown[]; attrs?: { text?: string; shortName?: string; url?: string } };
  if (n.type === "text") return n.text ?? "";
  if (n.type === "hardBreak") return "\n";
  if (n.type === "mention") return n.attrs?.text ?? "";
  if (n.type === "emoji") return n.attrs?.shortName ?? "";
  if (n.type === "inlineCard") return n.attrs?.url ?? "";
  const inner = adfText(n.content ?? [], depth + 1);
  if (n.type === "listItem") return `- ${inner.trim()}\n`;
  if (n.type === "paragraph" || n.type === "heading" || n.type === "codeBlock" || n.type === "blockquote") return `${inner}\n\n`;
  return inner;
}

export function jiPerson(u: JiUser): WorkPerson {
  return {
    id: u.accountId, ...(u.displayName ? { name: u.displayName } : {}), ...(u.emailAddress ? { email: u.emailAddress } : {}),
    ...(u.accountType && u.accountType !== "atlassian" ? { bot: true } : {}),
  };
}

export function jiItem(i: JiIssue, site: string): WorkItem {
  const f = i.fields;
  const cat = f.status?.statusCategory?.key;
  const res = (f.resolution?.name ?? "").toLowerCase();
  const status = cat === "done" ? (/won.?t|cancel|duplicate|declined|not a bug|obsolete/.test(res) ? "cancelled" : "done") : "open";
  const body = typeof f.description === "string" ? f.description : f.description ? adfText(f.description) : null;
  const fixed = (f.fixVersions ?? []).find((v) => v.releaseDate);
  return {
    id: i.id, key: i.key, kind: "issue", title: (f.summary ?? i.key).slice(0, 500), url: `${site}/browse/${encodeURIComponent(i.key)}`,
    state: (f.status?.name ?? status).slice(0, 80), status, ...(f.issuetype?.name ? { type: f.issuetype.name.slice(0, 80) } : {}),
    ...(f.reporter?.accountId ? { authorId: f.reporter.accountId } : {}), assigneeIds: f.assignee?.accountId ? [f.assignee.accountId] : [],
    labels: (f.labels ?? []).map((l) => l.trim()).filter(Boolean).slice(0, 30),
    ...(fixed ? { milestone: { name: fixed.name.slice(0, 200), ...(dayOf(fixed.releaseDate) ? { dueOn: dayOf(fixed.releaseDate) } : {}) } } : {}),
    ...(f.priority?.name ? { priority: f.priority.name.slice(0, 60) } : {}),
    createdAt: isoOf(f.created), updatedAt: isoOf(f.updated)!, closedAt: isoOf(f.resolutiondate),
    ...(dayOf(f.duedate) ? { dueOn: dayOf(f.duedate) } : {}), body: plainBody(body),
  };
}

/** Versions named on the issues: released ones in the window are releases, dated unreleased ones milestones. */
export function jiVersions(issues: JiIssue[], fromIso: string, site: string, projectKey: string) {
  const seen = new Map<string, JiVersion>();
  for (const i of issues) for (const v of i.fields.fixVersions ?? []) if (!seen.has(v.id) && !v.archived) seen.set(v.id, v);
  const url = `${site}/projects/${encodeURIComponent(projectKey)}/versions`;
  const releases = [...seen.values()].filter((v) => v.released && v.releaseDate && `${dayOf(v.releaseDate)}T23:59:59.999Z` > fromIso)
    .map((v) => ({ id: v.id, name: v.name.slice(0, 300), at: `${dayOf(v.releaseDate)}T00:00:00.000Z`, url, ...(v.description ? { body: v.description.slice(0, 4000) } : {}) }));
  const milestones = [...seen.values()].filter((v) => !v.released && v.releaseDate)
    .map((v) => ({ id: v.id, name: v.name.slice(0, 300), dueOn: dayOf(v.releaseDate), status: "open" as const, url, ...(v.description ? { description: v.description.slice(0, 2000) } : {}) }));
  return { releases, milestones };
}

/** Jira's error answers, in plain words (never echoing the body). */
export function jiraProblem(status: number): Error {
  if (status === 403) return needsYou("Jira refused to show this. The account may not have access to these projects.", "forbidden");
  if (status === 404) return needsYou("Jira couldn't find that. Check the site address and project keys.", "notFound");
  if (status === 400) return needsYou("Jira didn't accept the search. Check the project keys in the settings.", "badConfig");
  return needsYou(`Jira answered HTTP ${status}.`, "httpOther");
}
