import { describe, expect, it } from "vitest";
import { validateManifest } from "../manifest";
import { fakeApi, fakeCtx } from "../oauth/testing";
import { recordingDeps } from "../github/testing";
import { checkJira, jiraAuthorization, jiraConfig, jiraManifest, syncJira } from "./connector";
import { adfText, buildJql, jiItem, jiraSite, jiVersions, projectKey } from "./map";

describe("jira mapping", () => {
  it("has a valid manifest and only takes Jira Cloud addresses", () => {
    expect(validateManifest(jiraManifest)).toEqual({ ok: true });
    expect(jiraSite("acme.atlassian.net")).toBe("https://acme.atlassian.net");
    expect(jiraSite("https://acme.atlassian.net/jira/software/projects")).toBe("https://acme.atlassian.net");
    expect(jiraSite("http://acme.atlassian.net")).toBeNull();
    expect(jiraSite("https://evil.example.com")).toBeNull();
    expect(jiraSite("https://acme.atlassian.net.evil.com")).toBeNull();
    expect(jiraSite("https://u:p@acme.atlassian.net")).toBeNull();
    expect(jiraConfig.safeParse({ jiraSite: "x", jiraEmail: "a@b.co" }).success).toBe(false);
    expect(() => checkJira({})).toThrow(/API token/);
    expect(jiraAuthorization("a@b.co", "tok")).toBe(`Basic ${Buffer.from("a@b.co:tok").toString("base64")}`);
  });

  it("builds JQL only from safe project keys, starting a day early", () => {
    expect(projectKey("proj")).toBe("PROJ");
    expect(projectKey('A" OR 1=1')).toBeNull();
    expect(buildJql(["PROJ", "OPS"], new Date("2026-11-04T10:30:00Z"))).toBe('project in ("PROJ", "OPS") AND updated >= "2026-11-03 10:30" ORDER BY updated DESC');
    expect(buildJql([], new Date("2026-11-04T10:30:00Z"))).toMatch(/^\(assignee = currentUser\(\) OR reporter = currentUser\(\) OR watcher = currentUser\(\)\) AND/);
  });

  it("reads Atlassian Document Format as text", () => {
    const doc = { type: "doc", content: [
      { type: "paragraph", content: [{ type: "text", text: "Hello " }, { type: "mention", attrs: { text: "@Bo" } }] },
      { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] }] },
    ] };
    expect(adfText(doc)).toBe("Hello @Bo\n\n- one\n");
  });

  it("maps issues and versions", () => {
    const i = jiItem({ id: "1", key: "PROJ-7", fields: {
      summary: "Decide hosting", status: { name: "Done", statusCategory: { key: "done" } }, resolution: { name: "Done" }, issuetype: { name: "Decision" },
      reporter: { accountId: "r1", displayName: "Bo" }, assignee: { accountId: "a1", displayName: "Anna" }, duedate: "2026-11-10",
      updated: "2026-11-04T10:00:00.000+0100", fixVersions: [{ id: "v1", name: "1.0", released: true, releaseDate: "2026-11-01" }],
    } }, "https://acme.atlassian.net");
    expect(i).toMatchObject({ key: "PROJ-7", status: "done", type: "Decision", authorId: "r1", assigneeIds: ["a1"], dueOn: "2026-11-10", updatedAt: "2026-11-04T09:00:00.000Z", url: "https://acme.atlassian.net/browse/PROJ-7" });
    expect(jiItem({ id: "2", key: "P-2", fields: { status: { statusCategory: { key: "done" } }, resolution: { name: "Won't Do" }, updated: "2026-11-04T10:00:00.000+0000" } }, "https://a.atlassian.net").status).toBe("cancelled");
    const v = jiVersions([{ id: "1", key: "P-1", fields: { fixVersions: [{ id: "v1", name: "1.0", released: true, releaseDate: "2026-11-01" }, { id: "v2", name: "2.0", released: false, releaseDate: "2026-12-01" }, { id: "v0", name: "0.1", released: true, releaseDate: "2025-01-01" }] } }], "2026-10-01T00:00:00.000Z", "https://a.atlassian.net", "P");
    expect(v.releases.map((r) => r.name)).toEqual(["1.0"]);
    expect(v.milestones.map((m) => m.dueOn)).toEqual(["2026-12-01"]);
  });
});

describe("jira sync", () => {
  it("searches once, makes one batch per project, skips what it already read, and moves the cursor", async () => {
    const issues = [
      { id: "1", key: "PROJ-1", fields: { summary: "New", project: { id: "10", key: "PROJ", name: "Project" }, status: { name: "To Do", statusCategory: { key: "new" } }, assignee: { accountId: "me", displayName: "Anna" }, reporter: { accountId: "bo", displayName: "Bo" }, duedate: "2026-11-20", updated: "2026-11-04T10:00:00.000+0000" } },
      { id: "2", key: "OPS-1", fields: { summary: "Ops thing", project: { id: "11", key: "OPS", name: "Ops" }, status: { statusCategory: { key: "indeterminate" } }, updated: "2026-11-03T10:00:00.000+0000" } },
      { id: "3", key: "PROJ-0", fields: { summary: "Read last time", project: { id: "10", key: "PROJ", name: "Project" }, updated: "2026-10-01T00:00:00.000+0000" } },
    ];
    const bodies: Record<string, unknown>[] = [];
    const api = fakeApi(({ u, method, body }) => {
      if (u.pathname === "/rest/api/3/myself") return { json: { accountId: "me", displayName: "Anna Berg", emailAddress: "anna@example.com" } };
      if (u.pathname === "/rest/api/3/search/jql" && method === "POST") { bodies.push(JSON.parse(body ?? "{}")); return { json: { issues, isLast: true } }; }
      return undefined;
    });
    const { d, batches } = recordingDeps(api);
    const ctx = fakeCtx("jira", jiraConfig.parse({ jiraSite: "acme.atlassian.net", jiraEmail: "anna@example.com" }), { streams: { issues: { cursor: { updated: "2026-10-02T00:00:00.000Z" } } } });
    await syncJira(ctx, d);
    expect(String(bodies[0].jql)).toContain('updated >= "2026-10-01 00:00"');
    expect(batches.map((b) => [b.importer, b.batch.scope.name, b.batch.items?.map((i) => i.key)])).toEqual([["jira", "Project", ["PROJ-1"]], ["jira", "Ops", ["OPS-1"]]]);
    expect(batches[0].batch.me).toMatchObject({ id: "me", email: "anna@example.com" });
    expect(batches[0].externalId).toBe("jira:acme.atlassian.net:PROJ:2026-10-02T00:00:00.000Z");
    expect(ctx.state().streams?.issues?.cursor).toEqual({ updated: "2026-11-04T10:00:00.000Z" });
  });

  it("says plainly when Jira refuses", async () => {
    const api = fakeApi(() => ({ status: 403, json: {} }));
    const ctx = fakeCtx("jira", jiraConfig.parse({ jiraSite: "acme.atlassian.net", jiraEmail: "anna@example.com" }));
    await expect(syncJira(ctx, recordingDeps(api).d)).rejects.toMatchObject({ kind: "needs_you", code: "forbidden" });
  });
});
