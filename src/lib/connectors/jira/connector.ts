/**
 * Jira Cloud, read-only: the site address (https://<name>.atlassian.net), the person's Atlassian email and an API
 * token (id.atlassian.com, Security, API tokens), sent as HTTP Basic. Atlassian's tokens carry the person's own
 * access; My Graph only ever reads (GET /myself and the JQL search).
 *
 * One JQL search per run: the projects named in the settings, else the person's own issues (assigned, reported or
 * watched), updated since the cursor (newest first, at most 300 per run). One batch per project goes to the `jira`
 * importer: issues into the text; the project, the people on the person's own open issues, released and dated
 * versions, decisions and reminders for their due dates as one proposal. Cursor: the newest `updated` read.
 */
import { z } from "zod";
import type { WorkBatchInput, WorkPerson } from "@/lib/importers/github/work";
import { needsYou } from "../errors";
import { defineManifest } from "../manifest";
import { cursorOf } from "../state";
import type { RunContext } from "../types";
import { bodyOf } from "../oauth/client";
import { WORK_GRAPHS } from "../github/connector";
import { firstDay, newest, rateLimited, sendBatch, workCommon, type WorkDeps } from "../github/work";
import { buildJql, JIRA_FIELDS, jiItem, jiPerson, jiraProblem, jiraSite, jiVersions, projectKey, type JiIssue, type JiUser } from "./map";

const STREAM = "issues";
const PER_PAGE = 100;
const MAX_PAGES = 3;

const site = z.string().max(300).transform((s, c) => {
  const r = jiraSite(s);
  if (!r) { c.addIssue({ code: "custom", message: "Use your Jira Cloud address, like https://yourteam.atlassian.net." }); return z.NEVER; }
  return r;
});
const keys = z.array(z.string().max(40).transform((s, c) => {
  const k = projectKey(s);
  if (!k) { c.addIssue({ code: "custom", message: `"${s.slice(0, 40)}" isn't a project key (like PROJ).` }); return z.NEVER; }
  return k;
})).max(20, "Name at most 20 projects.").default([]);

export const jiraConfig = z.object({
  jiraSite: site,
  jiraEmail: z.string().trim().max(320).email("Use the email you sign in to Atlassian with."),
  jiraProjects: keys,
  ...workCommon,
  feedHost: z.string().max(300).optional(),
});
export type JiraConfig = z.infer<typeof jiraConfig>;
export const jiraSecrets = z.object({ jiraToken: z.string().max(500).optional() });

export const jiraManifest = defineManifest({
  id: "jira", version: "1", status: "official", icon: "work", graphKinds: WORK_GRAPHS,
  auth: { type: "api_key" },
  config: jiraConfig,
  secrets: jiraSecrets,
  fields: [
    { key: "jiraSite", kind: "url", required: true, placeholder: "https://yourteam.atlassian.net" },
    { key: "jiraEmail", kind: "text", required: true, placeholder: "you@company.com" },
    { key: "jiraToken", kind: "password", secret: true, required: true },
    { key: "jiraProjects", kind: "list", placeholder: "PROJ" },
    { key: "workSince", kind: "date" },
    { key: "visibility", kind: "visibility" },
  ],
  streams: [{ name: STREAM, key: "issue id", cursor: "newest updated", resetOn: [] }],
  schedule: { everyMinutes: 180 },
  rateLimit: { perMinute: 60, backoff: "exponential" },
  maps: { [STREAM]: "task" },
});

export function checkJira(secrets: Record<string, string>): void {
  const t = secrets.jiraToken?.trim();
  if (!t) throw needsYou("Paste an Atlassian API token.", "tokenMissing");
  if (t.length < 16 || /\s/.test(t)) throw needsYou("That doesn't look like an Atlassian API token.", "tokenFormat");
}

export const jiraAuthorization = (email: string, token: string) => `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;

type Cursor = { updated?: string };

export async function syncJira(ctx: RunContext<JiraConfig>, d: WorkDeps): Promise<void> {
  const base = ctx.config.jiraSite;
  const call = async (path: string, body?: unknown) => {
    const r = await d.api({ url: `${base}${path}`, method: body ? "POST" : "GET", headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    const limited = rateLimited(r, "Jira");
    if (limited) throw limited;
    if (r.status !== 200) throw jiraProblem(r.status);
    return r;
  };

  const meUser = bodyOf<JiUser>(await call("/rest/api/3/myself"), "Jira");
  const me: WorkPerson = jiPerson(meUser);

  const saved = cursorOf<Cursor>(ctx.state(), STREAM)?.updated ?? null;
  const from = saved ?? firstDay(ctx.config, ctx.now).toISOString();
  const jql = buildJql(ctx.config.jiraProjects, new Date(from));
  const issues: JiIssue[] = [];
  let token: string | undefined;
  let more = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await call("/rest/api/3/search/jql", { jql, fields: JIRA_FIELDS, maxResults: PER_PAGE, ...(token ? { nextPageToken: token } : {}) });
    const b = bodyOf<{ issues?: JiIssue[]; nextPageToken?: string | null; isLast?: boolean }>(r, "Jira");
    issues.push(...(b.issues ?? []));
    token = b.nextPageToken ?? undefined;
    if (b.isLast !== false || !token) break;
    if (page === MAX_PAGES) more = true;
  }
  if (more) ctx.log(`More issues changed than one run reads (${MAX_PAGES * PER_PAGE}); the newest were read, the rest left out.`);
  // The search starts a day early (JQL dates are in the person's Jira time zone): skip what was read already.
  const fresh = issues.filter((i) => { const u = i.fields.updated ? new Date(i.fields.updated).toISOString() : null; return !!u && (u > from || !saved); });

  const byProject = new Map<string, JiIssue[]>();
  for (const i of fresh) {
    const k = i.fields.project?.key;
    if (!k) continue;
    byProject.set(k, [...(byProject.get(k) ?? []), i]);
  }
  const until = ctx.now.toISOString();
  for (const [n, [key, list]] of [...byProject.entries()].entries()) {
    const project = list[0].fields.project!;
    const people = new Map<string, WorkPerson>();
    for (const i of list) for (const u of [i.fields.reporter, i.fields.assignee]) if (u?.accountId && !people.has(u.accountId)) people.set(u.accountId, jiPerson(u));
    const { releases, milestones } = jiVersions(list, from, base, key);
    const batch: WorkBatchInput = {
      format: "mygraph.work/1", provider: "jira",
      scope: { id: project.id, name: project.name, fullName: `${project.name} (${key})`, url: `${base}/browse/${encodeURIComponent(key)}`, kind: "project" },
      projects: [], me, people: [...people.values()], items: list.map((i) => jiItem(i, base)), milestones, releases,
      window: { since: from, until }, leftOut: n === 0 && more ? { moreItems: 1 } : {},
    };
    await sendBatch(ctx as RunContext<unknown>, d, STREAM, "jira", batch, { title: `Jira: ${project.name}`, externalId: `jira:${new URL(base).host}:${key}:${from}` });
  }
  const next = newest(fresh.map((i) => (i.fields.updated ? new Date(i.fields.updated).toISOString() : undefined)), from);
  await ctx.commit(STREAM, { updated: next } satisfies Cursor, async () => {});
}
