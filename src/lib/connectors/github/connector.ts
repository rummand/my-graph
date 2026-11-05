/**
 * GitHub, read-only, two ways in:
 *   github        a fine-grained personal access token (recommended): the person picks the repositories when making it
 *                 and gives only read permissions (Metadata, Issues, Pull requests, Contents for releases).
 *   github_oauth  "Sign in with GitHub" through the household's own GitHub App (read-only permissions set on the app,
 *                 repositories chosen when the person installs it), see oauth/providers.ts.
 *
 * Per repository (the ones named in the settings, else the 10 most recently pushed the token can see): issues and pull
 * requests updated since the cursor (newest first, at most 300 per run), releases published and milestones changed
 * since then. One batch per repository per run goes to the `github` importer, which keeps it as a source and proposes
 * what matters. Cursor per repository: the newest `updated_at` read.
 */
import { z } from "zod";
import { isMine } from "@/lib/importers/github/work";
import type { WorkBatchInput, WorkPerson } from "@/lib/importers/github/work";
import { needsYou } from "../errors";
import { defineManifest } from "../manifest";
import { cursorOf } from "../state";
import type { RunContext } from "../types";
import { bodyOf, unexpected, type ApiResponse } from "../oauth/client";
import { oauthSecrets } from "../oauth/fields";
import { ghItem, ghMilestone, ghPeople, ghPerson, ghRelease, repoName, type GhIssue, type GhMilestone, type GhRelease, type GhRepo, type GhUser } from "./map";
import { firstDay, newest, rateLimited, sendBatch, workCommon, type WorkDeps } from "./work";

export const WORK_GRAPHS = ["work", "project", "shared", "other", "personal"];
const STREAM = "issues";
export const MAX_REPOS = 10;
const PER_PAGE = 100;
const MAX_PAGES = 3;
const PEOPLE_LOOKUPS = 15;

const repoList = z.array(z.string().max(300).transform((s, c) => {
  const r = repoName(s);
  if (!r) { c.addIssue({ code: "custom", message: `"${s.slice(0, 60)}" isn't a repository. Write it as owner/name.` }); return z.NEVER; }
  return r;
})).max(20, "Name at most 20 repositories.").default([]);

export const githubConfig = z.object({ repos: repoList, ...workCommon });
export type GithubConfig = z.infer<typeof githubConfig>;

export const githubTokenSecrets = z.object({ githubToken: z.string().max(300).optional() });

const common = {
  version: "1", status: "official" as const, icon: "work" as const, graphKinds: WORK_GRAPHS,
  streams: [{ name: STREAM, key: "issue id", cursor: "newest updated_at per repository", resetOn: [] }],
  schedule: { everyMinutes: 180 },
  rateLimit: { perMinute: 60, backoff: "exponential" as const },
  maps: { [STREAM]: "task" as const },
};

export const githubManifest = defineManifest({
  id: "github", ...common, auth: { type: "api_key" }, config: githubConfig, secrets: githubTokenSecrets,
  fields: [
    { key: "githubToken", kind: "password", secret: true, required: true, placeholder: "github_pat_…" },
    { key: "repos", kind: "list", placeholder: "owner/repository" },
    { key: "workSince", kind: "date" },
    { key: "visibility", kind: "visibility" },
  ],
});

export const githubOAuthManifest = defineManifest({
  id: "github_oauth", ...common, auth: { type: "oauth2" }, config: githubConfig, secrets: oauthSecrets,
  fields: [{ key: "visibility", kind: "visibility" }],
});

/** Before saving a token: it is there and looks like a GitHub token (never sent anywhere to check). */
export function checkGithubToken(secrets: Record<string, string>): void {
  const t = secrets.githubToken?.trim();
  if (!t) throw needsYou("Paste a GitHub personal access token.", "tokenMissing");
  if (!/^(github_pat_|ghp_|gho_|ghu_)[A-Za-z0-9_]{20,}$/.test(t)) throw needsYou("That doesn't look like a GitHub token (they start with github_pat_ or ghp_).", "tokenFormat");
}

const GH_HEADERS = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };

type Cursor = { repos?: Record<string, string> };

export async function syncGithub(ctx: RunContext<GithubConfig>, d: WorkDeps): Promise<void> {
  const get = async (path: string, what: string, allow404 = false): Promise<ApiResponse | null> => {
    const r = await d.api({ url: `${d.base.github}${path}`, headers: GH_HEADERS });
    const limited = rateLimited(r, "GitHub");
    if (limited) throw limited;
    if (r.status === 404 && allow404) return null;
    if (r.status !== 200) throw unexpected(r, "GitHub", what);
    return r;
  };

  const meUser = bodyOf<GhUser>((await get("/user", "your account"))!, "GitHub");
  let meEmail = meUser.email ?? null;
  if (!meEmail) {
    // Best effort: the primary address, when the token may read it (fine-grained: "Email addresses", read).
    const r = await d.api({ url: `${d.base.github}/user/emails`, headers: GH_HEADERS }).catch(() => null);
    const list = r?.status === 200 ? r.json<{ email: string; primary?: boolean; verified?: boolean }[]>() : null;
    meEmail = list?.find((e) => e.primary && e.verified)?.email ?? null;
  }
  const me: WorkPerson = { ...ghPerson(meUser), ...(meEmail ? { email: meEmail } : {}) };

  const leftOutAll: Record<string, number> = {};
  let repos: GhRepo[] = [];
  if (ctx.config.repos.length) {
    for (const full of ctx.config.repos) {
      const r = await get(`/repos/${full}`, `the repository ${full}`, true);
      if (!r) { ctx.log(`The repository ${full} can't be found, or the token may not read it. It was skipped.`); ctx.count(STREAM, "skipped"); continue; }
      repos.push(bodyOf<GhRepo>(r, "GitHub"));
    }
  } else {
    const r = await get("/user/repos?sort=pushed&direction=desc&per_page=50&affiliation=owner,collaborator,organization_member", "your repositories");
    const all = bodyOf<GhRepo[]>(r!, "GitHub");
    const live = all.filter((x) => !x.archived);
    if (all.length - live.length) leftOutAll.archived = all.length - live.length;
    repos = live.slice(0, MAX_REPOS);
    if (live.length > MAX_REPOS) {
      leftOutAll.repos = live.length - MAX_REPOS;
      ctx.log(`Read the ${MAX_REPOS} most recently changed repositories; ${live.length - MAX_REPOS} more were left out. Name the ones you want in the settings.`);
    }
    if (!repos.length) ctx.log("The token can't see any repositories yet. Give it access to some on GitHub.");
  }

  let cursor: Cursor = cursorOf<Cursor>(ctx.state(), STREAM) ?? {};
  const looked = new Map<string, GhUser>();
  let lookups = 0;
  const first = firstDay(ctx.config, ctx.now).toISOString();
  const until = ctx.now.toISOString();

  for (const [n, repo] of repos.entries()) {
    const full = repo.full_name;
    const since = cursor.repos?.[full] ?? null;
    const from = since ?? first;
    // Repositories left out are said once, in the first batch.
    const leftOut: Record<string, number> = n === 0 ? { ...leftOutAll } : {};

    const issues: GhIssue[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const r = await get(`/repos/${full}/issues?state=all&sort=updated&direction=desc&per_page=${PER_PAGE}&page=${page}&since=${encodeURIComponent(from)}`, `the issues of ${full}`, true);
      if (!r) break;
      const got = bodyOf<GhIssue[]>(r, "GitHub");
      issues.push(...got);
      if (got.length < PER_PAGE) break;
      if (page === MAX_PAGES) {
        leftOut.moreItems = 1;
        ctx.log(`${full} has more than ${MAX_PAGES * PER_PAGE} changed issues and pull requests; the newest were read, the rest left out.`);
      }
    }
    // `since` includes the cursor's own second: what was read last time is not read again.
    const fresh = issues.filter((i) => !since || (i.updated_at && new Date(i.updated_at).toISOString() > since));
    const items = fresh.map(ghItem);

    const rel = await get(`/repos/${full}/releases?per_page=20`, `the releases of ${full}`, true);
    const releases = (rel ? bodyOf<GhRelease[]>(rel, "GitHub") : [])
      .filter((x) => !x.draft && (x.published_at ?? x.created_at) && new Date((x.published_at ?? x.created_at)!).toISOString() > from)
      .map(ghRelease);
    const ms = await get(`/repos/${full}/milestones?state=all&sort=due_on&direction=desc&per_page=30`, `the milestones of ${full}`, true);
    const milestones = (ms ? bodyOf<GhMilestone[]>(ms, "GitHub") : [])
      .filter((m) => m.updated_at && new Date(m.updated_at).toISOString() > from)
      .map(ghMilestone);

    // People: everyone named, with real names and public addresses looked up for those on the person's own work.
    const named = ghPeople(fresh);
    const mineLogins = new Set(items.filter((i) => isMine(i, me.id)).flatMap((i) => [i.authorId, ...i.assigneeIds]).filter((x): x is string => !!x && x !== me.id));
    let unlooked = 0;
    for (const login of mineLogins) {
      if (looked.has(login)) continue;
      if (lookups >= PEOPLE_LOOKUPS || named.get(login)?.type === "Bot") { unlooked++; continue; }
      lookups++;
      const r = await d.api({ url: `${d.base.github}/users/${encodeURIComponent(login)}`, headers: GH_HEADERS }).catch(() => null);
      const u = r?.status === 200 ? r.json<GhUser>() : null;
      if (u) looked.set(login, u);
    }
    if (unlooked) leftOut.people = unlooked;
    const people = [...named.values()].map((u) => ghPerson({ ...u, ...(looked.get(u.login) ?? {}) }));

    const batch: WorkBatchInput = {
      format: "mygraph.work/1", provider: "github",
      scope: { id: String(repo.id), name: repo.name, fullName: full, url: repo.html_url, kind: "repository", ...(repo.description ? { description: repo.description.slice(0, 2000) } : {}) },
      projects: [], me, people, items, milestones, releases, window: { since: from, until }, leftOut,
    };
    await sendBatch(ctx as RunContext<unknown>, d, STREAM, "github", batch, { title: `GitHub: ${full}`, externalId: `github:${full}:${from}` });
    const next = newest([...items.map((i) => i.updatedAt), ...releases.map((r) => r.at)], from);
    cursor = { repos: { ...(cursor.repos ?? {}), [full]: next } };
    await ctx.commit(STREAM, cursor, async () => {});
  }
}
