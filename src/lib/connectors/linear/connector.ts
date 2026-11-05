/**
 * Linear, read-only, two ways in:
 *   linear        a personal API key (Settings, Security & access, Personal API keys; give it Read only).
 *   linear_oauth  "Sign in with Linear" through the household's own Linear OAuth app (scope read), see oauth/providers.ts.
 *
 * Per team (the team keys named in the settings, else the person's own teams, at most 5): issues updated since the
 * cursor (newest first, at most 300 per run) with state, assignee, due date, labels, project and cycle, and the team's
 * projects. One batch per team per run goes to the `linear` importer: issues into the text, the team, projects the
 * person works in, people on their own open issues, project target dates and reminders for the due dates of their own
 * issues as one proposal. Cursor per team: the newest `updatedAt` read.
 */
import { z } from "zod";
import type { WorkBatchInput } from "@/lib/importers/github/work";
import { needsYou } from "../errors";
import { defineManifest } from "../manifest";
import { cursorOf } from "../state";
import type { RunContext } from "../types";
import { oauthSecrets } from "../oauth/fields";
import { WORK_GRAPHS } from "../github/connector";
import { firstDay, newest, sendBatch, workCommon, type WorkDeps } from "../github/work";
import { graphqlProblem, ISSUES_QUERY, lnItem, lnPeople, lnPerson, lnTarget, PROJECTS_QUERY, VIEWER_QUERY, type LnIssue, type LnProject, type LnTeam, type LnUser } from "./map";

const STREAM = "issues";
export const MAX_TEAMS = 5;
const MAX_PAGES = 6;

const teamKeys = z.array(z.string().max(40).transform((s, c) => {
  const k = s.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{0,19}$/.test(k)) { c.addIssue({ code: "custom", message: `"${s.slice(0, 40)}" isn't a team key (like ENG).` }); return z.NEVER; }
  return k;
})).max(20, "Name at most 20 teams.").default([]);

export const linearConfig = z.object({ teams: teamKeys, ...workCommon });
export type LinearConfig = z.infer<typeof linearConfig>;
export const linearKeySecrets = z.object({ linearApiKey: z.string().max(300).optional() });

const common = {
  version: "1", status: "official" as const, icon: "work" as const, graphKinds: WORK_GRAPHS,
  streams: [{ name: STREAM, key: "issue id", cursor: "newest updatedAt per team", resetOn: [] }],
  schedule: { everyMinutes: 180 },
  rateLimit: { perMinute: 60, backoff: "exponential" as const },
  maps: { [STREAM]: "task" as const },
};

export const linearManifest = defineManifest({
  id: "linear", ...common, auth: { type: "api_key" }, config: linearConfig, secrets: linearKeySecrets,
  fields: [
    { key: "linearApiKey", kind: "password", secret: true, required: true, placeholder: "lin_api_…" },
    { key: "teams", kind: "list", placeholder: "ENG" },
    { key: "workSince", kind: "date" },
    { key: "visibility", kind: "visibility" },
  ],
});

export const linearOAuthManifest = defineManifest({
  id: "linear_oauth", ...common, auth: { type: "oauth2" }, config: linearConfig, secrets: oauthSecrets,
  fields: [{ key: "visibility", kind: "visibility" }],
});

export function checkLinearKey(secrets: Record<string, string>): void {
  const k = secrets.linearApiKey?.trim();
  if (!k) throw needsYou("Paste a Linear personal API key.", "tokenMissing");
  if (!/^lin_api_[A-Za-z0-9]{20,}$/.test(k)) throw needsYou("That doesn't look like a Linear API key (they start with lin_api_).", "tokenFormat");
}

type Cursor = { teams?: Record<string, string> };

export async function syncLinear(ctx: RunContext<LinearConfig>, d: WorkDeps): Promise<void> {
  const gql = async <T>(query: string, variables: Record<string, unknown> = {}): Promise<T> => {
    const r = await d.api({ url: d.base.linear, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables }) });
    const body = r.json<{ data?: T; errors?: { message?: string; extensions?: { code?: string; type?: string } }[] }>();
    const problem = graphqlProblem(r.status, body);
    if (problem) throw problem;
    if (!body?.data) throw needsYou("Linear answered without any data.", "httpOther");
    return body.data;
  };

  const v = await gql<{ viewer: LnUser & { teams?: { nodes?: LnTeam[] } } }>(VIEWER_QUERY);
  const me = lnPerson(v.viewer);
  const mine = v.viewer.teams?.nodes ?? [];
  const leftOutAll: Record<string, number> = {};
  let teams: LnTeam[];
  if (ctx.config.teams.length) {
    teams = [];
    for (const key of ctx.config.teams) {
      const t = mine.find((x) => x.key.toUpperCase() === key);
      if (t) teams.push(t);
      else { ctx.log(`You're not in a Linear team with the key ${key}, so it was skipped.`); ctx.count(STREAM, "skipped"); }
    }
  } else {
    teams = mine.slice(0, MAX_TEAMS);
    if (mine.length > MAX_TEAMS) {
      leftOutAll.teams = mine.length - MAX_TEAMS;
      ctx.log(`Read ${MAX_TEAMS} of your ${mine.length} teams. Name the ones you want in the settings.`);
    }
  }

  let cursor: Cursor = cursorOf<Cursor>(ctx.state(), STREAM) ?? {};
  const first = firstDay(ctx.config, ctx.now).toISOString();
  const until = ctx.now.toISOString();

  for (const [n, team] of teams.entries()) {
    const since = cursor.teams?.[team.id] ?? null;
    const from = since ?? first;
    const leftOut: Record<string, number> = n === 0 ? { ...leftOutAll } : {};
    const issues: LnIssue[] = [];
    let after: string | null = null;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const data: { team: { issues: { nodes: LnIssue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } | null } =
        await gql(ISSUES_QUERY, { team: team.id, since: from, after });
      if (!data.team) break;
      issues.push(...data.team.issues.nodes);
      if (!data.team.issues.pageInfo.hasNextPage) break;
      after = data.team.issues.pageInfo.endCursor;
      if (page === MAX_PAGES) {
        leftOut.moreItems = 1;
        ctx.log(`${team.name} has more changed issues than one run reads; the newest were read, the rest left out.`);
      }
    }
    const pj = await gql<{ team: { projects: { nodes: LnProject[] } } | null }>(PROJECTS_QUERY, { team: team.id });
    const allProjects = pj.team?.projects.nodes ?? [];
    const used = new Set(issues.map((i) => i.project?.id).filter(Boolean));
    const projects = allProjects.filter((p) => used.has(p.id) || (!p.completedAt && !p.canceledAt));
    const milestones = projects.filter((p) => p.updatedAt && p.updatedAt > from).map(lnTarget).filter((m): m is NonNullable<typeof m> => !!m && !!m.dueOn);

    const items = issues.map(lnItem);
    const batch: WorkBatchInput = {
      format: "mygraph.work/1", provider: "linear",
      scope: { id: team.id, name: team.name, fullName: `${team.name} (${team.key})`, kind: "team", ...(team.description ? { description: team.description.slice(0, 2000) } : {}) },
      projects: projects.map((p) => ({ id: p.id, name: p.name.slice(0, 200), ...(p.url ? { url: p.url } : {}), ...(p.description ? { description: p.description.slice(0, 2000) } : {}), ...(p.lead?.id ? { leadId: p.lead.id } : {}) })),
      me, people: lnPeople(issues, projects.map((p) => p.lead)), items, milestones, releases: [], window: { since: from, until }, leftOut,
    };
    await sendBatch(ctx as RunContext<unknown>, d, STREAM, "linear", batch, { title: `Linear: ${team.name}`, externalId: `linear:${team.id}:${from}` });
    cursor = { teams: { ...(cursor.teams ?? {}), [team.id]: newest(items.map((i) => i.updatedAt), from) } };
    await ctx.commit(STREAM, cursor, async () => {});
  }
}
