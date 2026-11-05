import { describe, expect, it } from "vitest";
import { validateManifest } from "../manifest";
import { fakeApi, fakeCtx } from "../oauth/testing";
import { providerInfo, unwrapGithubToken, buildAuthorizeUrl, SCOPES } from "../oauth/providers";
import { checkGithubToken, githubConfig, githubManifest, githubOAuthManifest, syncGithub } from "./connector";
import { ghItem, repoName } from "./map";
import { recordingDeps as workDeps } from "./testing";
import { keyApi, plainBody } from "./work";

describe("github mapping", () => {
  it("has valid manifests, offered outside family graphs", () => {
    expect(validateManifest(githubManifest)).toEqual({ ok: true });
    expect(validateManifest(githubOAuthManifest)).toEqual({ ok: true });
    expect(githubManifest.graphKinds).not.toContain("family");
  });

  it("reads repository names however they were typed", () => {
    expect(repoName("acme/my-graph")).toBe("acme/my-graph");
    expect(repoName("https://github.com/acme/my-graph.git")).toBe("acme/my-graph");
    expect(repoName("git@github.com:acme/my-graph.git")).toBe("acme/my-graph");
    expect(repoName("acme/../etc")).toBeNull();
    expect(repoName("not a repo")).toBeNull();
    expect(githubConfig.safeParse({ repos: ["nope"] }).success).toBe(false);
    expect(githubConfig.parse({ repos: ["https://github.com/a/b"] }).repos).toEqual(["a/b"]);
  });

  it("checks a token's shape without sending it anywhere", () => {
    expect(() => checkGithubToken({})).toThrow(/Paste/);
    expect(() => checkGithubToken({ githubToken: "hunter2" })).toThrow(/doesn't look like/);
    expect(() => checkGithubToken({ githubToken: `github_pat_${"a".repeat(30)}` })).not.toThrow();
  });

  it("maps issues and pull requests: merged, not planned, drafts", () => {
    const pr = ghItem({ id: 9, number: 7, title: "Dark mode", state: "closed", updated_at: "2026-11-01T10:00:00Z", pull_request: { merged_at: "2026-11-01T10:00:00Z" }, user: { login: "anna" }, labels: [{ name: "ui" }], body: "<!-- template -->\nAdds it." });
    expect(pr).toMatchObject({ key: "#7", kind: "pull_request", state: "merged", status: "done", authorId: "anna", labels: ["ui"], body: "Adds it.", mergedAt: "2026-11-01T10:00:00.000Z" });
    expect(ghItem({ id: 1, number: 1, title: "x", state: "closed", state_reason: "not_planned", updated_at: "2026-11-01T10:00:00Z" }).status).toBe("cancelled");
    expect(ghItem({ id: 2, number: 2, title: "x", state: "closed", updated_at: "2026-11-01T10:00:00Z", pull_request: { merged_at: null } }).status).toBe("cancelled");
    expect(ghItem({ id: 3, number: 3, title: "x", state: "open", draft: true, updated_at: "2026-11-01T10:00:00Z", pull_request: {}, milestone: { id: 1, title: "v2", state: "open", due_on: "2026-12-01T08:00:00Z" } })).toMatchObject({ state: "draft", status: "open", milestone: { name: "v2", dueOn: "2026-12-01" } });
    expect(plainBody("a\n\n\n\nb")).toBe("a\n\nb");
  });
});

describe("github oauth provider", () => {
  it("is a read-only sign-in with GitHub's own error names mapped", () => {
    const p = providerInfo("github", { GITHUB_CLIENT_ID: "Iv1.abc", GITHUB_CLIENT_SECRET: "s" });
    expect(p.missing).toEqual([]);
    expect(providerInfo("github", {}).missing).toEqual(["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"]);
    expect(SCOPES.github_oauth).not.toContain("repo");
    const url = new URL(buildAuthorizeUrl(p, "github_oauth", { redirectUri: "https://g.example/cb", state: "s", challenge: "c" }));
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(unwrapGithubToken({ error: "bad_refresh_token" })).toMatchObject({ error: "invalid_grant" });
    expect(unwrapGithubToken({ error: "incorrect_client_credentials" })).toMatchObject({ error: "invalid_client" });
    expect(unwrapGithubToken({ access_token: "t" })).toEqual({ access_token: "t" });
    expect(providerInfo("linear", { LINEAR_CLIENT_ID: "a", LINEAR_CLIENT_SECRET: "b" }).tokenUrl).toBe("https://api.linear.app/oauth/token");
  });
});

function githubServer() {
  const s = { issues: [] as unknown[], users: 0 };
  const api = fakeApi(({ u }) => {
    const p = u.pathname;
    if (p === "/user") return { json: { login: "anna", id: 1, name: "Anna Berg", email: null } };
    if (p === "/user/emails") return { json: [{ email: "anna@example.com", primary: true, verified: true }] };
    if (p === "/user/repos") return { json: [
      { id: 10, name: "my-graph", full_name: "acme/my-graph", html_url: "https://github.com/acme/my-graph", pushed_at: "2026-11-04T00:00:00Z" },
      { id: 11, name: "old", full_name: "acme/old", archived: true },
    ] };
    if (p === "/repos/acme/my-graph/issues") {
      expect(u.searchParams.get("since")).toBeTruthy();
      return { json: s.issues };
    }
    if (p === "/repos/acme/my-graph/releases") return { json: [
      { id: 5, tag_name: "v1.2.0", name: "v1.2.0", published_at: "2026-10-28T10:00:00Z", html_url: "https://github.com/acme/my-graph/releases/tag/v1.2.0" },
      { id: 4, tag_name: "v0.1", published_at: "2025-01-01T10:00:00Z" },
      { id: 6, tag_name: "v1.3.0-draft", draft: true, created_at: "2026-11-01T10:00:00Z" },
    ] };
    if (p === "/repos/acme/my-graph/milestones") return { json: [{ id: 3, title: "v1.3", state: "open", due_on: "2026-11-20T08:00:00Z", updated_at: "2026-11-02T00:00:00Z" }] };
    if (p.startsWith("/users/")) { s.users++; return { json: { login: p.slice(7), name: "Bo Holm", email: "bo@example.com" } }; }
    if (p === "/repos/acme/gone") return { status: 404, json: { message: "Not Found" } };
    return undefined;
  });
  return { api, s };
}

describe("github sync", () => {
  const issue = (n: number, updated: string, extra: Record<string, unknown> = {}) => ({ id: 100 + n, number: n, title: `Issue ${n}`, state: "open", updated_at: updated, user: { login: "bo" }, assignees: [{ login: "anna" }], labels: [], ...extra });

  it("reads the most recent repositories, skips archived ones, and moves the cursor per repository", async () => {
    const g = githubServer();
    g.s.issues = [issue(1, "2026-11-04T09:00:00Z"), issue(2, "2026-11-03T09:00:00Z", { user: { login: "dependabot[bot]", type: "Bot" }, assignees: [] })];
    const { d, batches } = workDeps(g.api);
    const ctx = fakeCtx("github", githubConfig.parse({}));
    await syncGithub(ctx, d);
    expect(batches).toHaveLength(1);
    const b = batches[0];
    expect(b).toMatchObject({ importer: "github", title: "GitHub: acme/my-graph" });
    expect(b.externalId).toMatch(/^github:acme\/my-graph:2026-08-06T10:00/);
    expect(b.batch.me).toMatchObject({ id: "anna", email: "anna@example.com" });
    expect(b.batch.items?.map((i) => i.key)).toEqual(["#1", "#2"]);
    expect(b.batch.releases?.map((r) => r.name)).toEqual(["v1.2.0"]);
    expect(b.batch.milestones?.map((m) => m.dueOn)).toEqual(["2026-11-20"]);
    expect(b.batch.leftOut).toEqual({ archived: 1 });
    expect(b.batch.people?.find((p) => p.id === "bo")).toMatchObject({ name: "Bo Holm" });
    expect(g.s.users).toBe(1); // only Bo (on my work) is looked up, never the bot
    expect(ctx.state().streams?.issues?.cursor).toEqual({ repos: { "acme/my-graph": "2026-11-04T09:00:00.000Z" } });

    // Next run: GitHub's `since` includes the cursor's second, so what was read isn't sent again.
    g.s.issues = [issue(1, "2026-11-04T09:00:00Z")];
    await syncGithub(ctx, d);
    expect(batches).toHaveLength(1); // nothing new: no empty batch is stored
    expect(ctx.state().streams?.issues?.cursor).toEqual({ repos: { "acme/my-graph": "2026-11-04T09:00:00.000Z" } });
  });

  it("reads named repositories and skips the ones it can't see", async () => {
    const g = githubServer();
    g.s.issues = [];
    const { d, batches } = workDeps(g.api);
    const ctx = fakeCtx("github", githubConfig.parse({ repos: ["acme/gone"] }));
    await syncGithub(ctx, d);
    expect(batches).toHaveLength(0);
    expect(ctx.counts.issues.skipped).toBe(1);
    expect(ctx.logs.join(" ")).toMatch(/acme\/gone can't be found/);
  });

  it("says when GitHub's rate limit is spent, and asks for a new token when it is refused", async () => {
    const limited = fakeApi(() => ({ status: 403, headers: { "x-ratelimit-remaining": "0" }, json: { message: "API rate limit exceeded" } }));
    await expect(syncGithub(fakeCtx("github", githubConfig.parse({})), workDeps(limited).d)).rejects.toMatchObject({ kind: "retry", code: "rateLimited" });
    const refused = keyApi({ transport: async (r) => ({ status: 401, headers: {}, body: Buffer.from("{}"), url: r.url }), authorization: "Bearer x", who: "GitHub" });
    await expect(syncGithub(fakeCtx("github", githubConfig.parse({})), workDeps(refused).d)).rejects.toMatchObject({ kind: "needs_you", code: "tokenRefused" });
  });

  it("sends the token only as the Authorization header", async () => {
    const seen: Record<string, string>[] = [];
    const api = keyApi({ transport: async (r) => { seen.push(r.headers ?? {}); return { status: 200, headers: {}, body: Buffer.from("{}"), url: r.url }; }, authorization: "Bearer github_pat_x", who: "GitHub" });
    await api({ url: "https://api.github.com/user" });
    expect(seen[0].authorization).toBe("Bearer github_pat_x");
  });
});
