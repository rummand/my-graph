import { describe, expect, it } from "vitest";
import { validateManifest } from "../manifest";
import { fakeApi, fakeCtx } from "../oauth/testing";
import { recordingDeps } from "../github/testing";
import { checkLinearKey, linearConfig, linearManifest, linearOAuthManifest, syncLinear } from "./connector";
import { graphqlProblem, lnItem, lnTarget } from "./map";

describe("linear mapping", () => {
  it("has valid manifests and checks a key's shape", () => {
    expect(validateManifest(linearManifest)).toEqual({ ok: true });
    expect(validateManifest(linearOAuthManifest)).toEqual({ ok: true });
    expect(() => checkLinearKey({ linearApiKey: "nope" })).toThrow(/lin_api_/);
    expect(() => checkLinearKey({ linearApiKey: `lin_api_${"a".repeat(40)}` })).not.toThrow();
    expect(linearConfig.parse({ teams: ["eng", " ops "] }).teams).toEqual(["ENG", "OPS"]);
    expect(linearConfig.safeParse({ teams: ["a b"] }).success).toBe(false);
  });

  it("maps issues: state types, cycle, due date, no-priority", () => {
    const i = lnItem({
      id: "1", identifier: "ENG-1", title: "Ship", updatedAt: "2026-11-04T09:00:00.000Z", dueDate: "2026-11-10", priorityLabel: "No priority",
      state: { name: "In Progress", type: "started" }, assignee: { id: "u1" }, creator: { id: "u2" }, labels: { nodes: [{ name: "api" }] },
      project: { id: "p1" }, cycle: { number: 12, startsAt: "2026-11-03T00:00:00.000Z", endsAt: "2026-11-17T00:00:00.000Z" },
    });
    expect(i).toMatchObject({ key: "ENG-1", status: "open", state: "In Progress", assigneeIds: ["u1"], authorId: "u2", projectId: "p1", dueOn: "2026-11-10", cycle: "Cycle 12 (2026-11-03 to 2026-11-17)", labels: ["api"] });
    expect(i.priority).toBeUndefined();
    expect(lnItem({ id: "2", identifier: "ENG-2", title: "x", updatedAt: "2026-11-04T09:00:00.000Z", state: { type: "canceled" } }).status).toBe("cancelled");
    expect(lnTarget({ id: "p", name: "Mesh", targetDate: "2026-12-01" })).toMatchObject({ dueOn: "2026-12-01", name: "Mesh target date" });
    expect(lnTarget({ id: "p", name: "Mesh", targetDate: "2026-12-01", completedAt: "2026-11-01T00:00:00Z" })).toBeNull();
  });

  it("sorts GraphQL errors into needs-you and will-retry", () => {
    expect(graphqlProblem(400, { errors: [{ message: "Authentication required", extensions: { code: "AUTHENTICATION_ERROR" } }] })).toMatchObject({ kind: "needs_you", code: "tokenRefused" });
    expect(graphqlProblem(400, { errors: [{ message: "x", extensions: { code: "RATELIMITED" } }] })).toMatchObject({ kind: "retry" });
    expect(graphqlProblem(200, { errors: [] })).toBeNull();
  });
});

describe("linear sync", () => {
  it("reads the person's teams, the projects in use, and moves the cursor per team", async () => {
    const calls: { query: string; variables: Record<string, unknown> }[] = [];
    const api = fakeApi(({ body, headers }) => {
      expect(headers?.["content-type"]).toBe("application/json");
      const b = JSON.parse(body ?? "{}") as { query: string; variables: Record<string, unknown> };
      calls.push(b);
      if (b.query.includes("MyGraphViewer")) return { json: { data: { viewer: { id: "u1", name: "Anna Berg", displayName: "anna", email: "anna@example.com", teams: { nodes: [{ id: "t1", key: "ENG", name: "Engineering" }, { id: "t2", key: "OPS", name: "Ops" }] } } } } };
      if (b.query.includes("MyGraphIssues")) {
        if (b.variables.team === "t2") return { json: { data: { team: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } };
        if (!b.variables.after) return { json: { data: { team: { issues: { nodes: [{ id: "a", identifier: "ENG-1", title: "Ship", updatedAt: "2026-11-04T09:00:00.000Z", dueDate: "2026-11-10", state: { name: "Todo", type: "unstarted" }, assignee: { id: "u1", name: "Anna Berg" }, creator: { id: "u2", name: "Bo Holm" }, project: { id: "p1" } }], pageInfo: { hasNextPage: true, endCursor: "c1" } } } } } };
        return { json: { data: { team: { issues: { nodes: [{ id: "b", identifier: "ENG-2", title: "Older", updatedAt: "2026-11-01T09:00:00.000Z", state: { type: "completed" } }], pageInfo: { hasNextPage: false, endCursor: null } } } } } };
      }
      if (b.query.includes("MyGraphProjects")) return { json: { data: { team: { projects: { nodes: [
        { id: "p1", name: "Data Mesh", targetDate: "2026-12-01", updatedAt: "2026-11-02T00:00:00.000Z", lead: { id: "u1", name: "Anna Berg" } },
        { id: "p9", name: "Done long ago", completedAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z" },
      ] } } } } };
      return undefined;
    });
    const { d, batches } = recordingDeps(api);
    const ctx = fakeCtx("linear", linearConfig.parse({ teams: ["eng", "nope"] }));
    await syncLinear(ctx, d);
    expect(batches).toHaveLength(1);
    const b = batches[0].batch;
    expect(b.scope).toMatchObject({ name: "Engineering", kind: "team" });
    expect(b.me).toMatchObject({ id: "u1", email: "anna@example.com" });
    expect(b.items?.map((i) => i.key)).toEqual(["ENG-1", "ENG-2"]);
    expect(b.projects?.map((p) => p.name)).toEqual(["Data Mesh"]);
    expect(b.milestones?.map((m) => m.dueOn)).toEqual(["2026-12-01"]);
    expect(ctx.logs.join(" ")).toMatch(/key NOPE/);
    expect(ctx.state().streams?.issues?.cursor).toEqual({ teams: { t1: "2026-11-04T09:00:00.000Z" } });
    expect(calls.find((c) => c.query.includes("MyGraphIssues"))?.variables.since).toBe("2026-08-06T10:00:00.000Z");
  });
});
