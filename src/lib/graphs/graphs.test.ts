import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { canEditItem, canReadEdgeItem, canReadItem, ctxFor, nodeEditSql, nodeReadSql, sourceReadSql, type AccessItem } from "@/lib/gbrain/access";
import { canSee, canModify } from "@/lib/people/access";
import { canReadPage, canEditPage } from "@/lib/pages/access";
import { canSeeItem, canManageReminder, visibleChildren } from "@/lib/briefs/access";
import { canReadSourceRow, canEditSourceRow } from "@/lib/ingest/access";
import {
  archiveProblem, assertSameGraph, familyGraphRole, inviteState, memberChangeProblem, pickGraph, scopeOf,
  type GraphContext, type Role,
} from "./pure";

const FAMILY_HH = "hh-anna", SARA_HH = "hh-sara";
const G = { family: "g-family", work: "g-work", forSara: "g-for-sara", saraPersonal: "g-sara-personal" };

const family: Omit<GraphContext, "graphRole"> = { graphId: G.family, graphName: "Family", graphKind: "family", graphHouseholdId: FAMILY_HH, graphOwnerId: "anna" };
const work: Omit<GraphContext, "graphRole"> = { graphId: G.work, graphName: "Work", graphKind: "work", graphHouseholdId: FAMILY_HH, graphOwnerId: "anna" };
const forSara: Omit<GraphContext, "graphRole"> = { graphId: G.forSara, graphName: "For Sara", graphKind: "shared", graphHouseholdId: FAMILY_HH, graphOwnerId: "anna" };

const viewer = (id: string, householdId: string, role: Role, g: Omit<GraphContext, "graphRole">, graphRole: GraphContext["graphRole"]) =>
  ({ id, householdId, role, ...g, graphRole });

const annaFamily = viewer("anna", FAMILY_HH, "owner", family, "owner");
const annaWork = viewer("anna", FAMILY_HH, "owner", work, "owner");
const annaForSara = viewer("anna", FAMILY_HH, "owner", forSara, "owner");
const mikkelFamily = viewer("mikkel", FAMILY_HH, "parent", family, "editor");
const emmaFamily = viewer("emma", FAMILY_HH, "child", family, "viewer");
const saraEditor = viewer("sara", SARA_HH, "owner", forSara, "editor");
const saraViewer = viewer("sara", SARA_HH, "owner", forSara, "viewer");

const item = (graphId: string, p: Partial<AccessItem> = {}): AccessItem =>
  ({ ownerId: "anna", householdId: FAMILY_HH, visibility: "household", sensitive: false, graphId, ...p });

const dialect = new PgDialect();
const render = (s: ReturnType<typeof nodeReadSql>) => dialect.sqlToQuery(s);

describe("scopeOf", () => {
  it("family graph keeps the household role and household", () => {
    expect(scopeOf(mikkelFamily)).toMatchObject({ role: "parent", householdId: FAMILY_HH, family: true, canWrite: true, graphId: G.family });
    expect(scopeOf(emmaFamily)).toMatchObject({ role: "child", family: true, canWrite: true });
  });
  it("a shared graph uses the graph role and the owner's household", () => {
    expect(scopeOf(saraEditor)).toMatchObject({ role: "parent", householdId: FAMILY_HH, family: false, canWrite: true, graphId: G.forSara });
    expect(scopeOf(saraViewer)).toMatchObject({ role: "child", family: false, canWrite: false });
  });
  it("someone else's family graph never gets family rules", () => {
    const outsider = viewer("x", SARA_HH, "owner", family, "viewer");
    expect(scopeOf(outsider).family).toBe(false);
    expect(scopeOf(outsider).canWrite).toBe(false);
  });
  it("maps household roles to family graph roles", () => {
    expect([familyGraphRole("owner"), familyGraphRole("parent"), familyGraphRole("child"), familyGraphRole("guest")]).toEqual(["owner", "editor", "viewer", "viewer"]);
  });
});

describe("cross-graph denial", () => {
  it("nothing from another graph is readable, not even your own items", () => {
    const familyItem = item(G.family, { ownerId: "anna" });
    expect(canReadItem(ctxFor(annaFamily), familyItem)).toBe(true);
    expect(canReadItem(ctxFor(annaWork), familyItem)).toBe(false);
    expect(canReadItem(ctxFor(annaForSara), familyItem)).toBe(false);
    expect(canReadItem(ctxFor(saraEditor), familyItem)).toBe(false);
    expect(canReadItem(ctxFor(saraEditor), item(G.work))).toBe(false);
  });
  it("a share can't carry an item into another graph", () => {
    expect(canReadItem(ctxFor(saraEditor), item(G.family, { visibility: "private" }), [{ canEdit: true, expiresAt: null }])).toBe(false);
    expect(canEditItem(ctxFor(saraEditor), item(G.family), [{ canEdit: true, expiresAt: null }])).toBe(false);
  });
  it("an edge is invisible if it or either end belongs to another graph", () => {
    const ctx = ctxFor(saraEditor);
    const inSara = { item: item(G.forSara) };
    expect(canReadEdgeItem(ctx, item(G.forSara), inSara, inSara)).toBe(true);
    expect(canReadEdgeItem(ctx, item(G.family), inSara, inSara)).toBe(false);
    expect(canReadEdgeItem(ctx, item(G.forSara), inSara, { item: item(G.family) })).toBe(false);
  });
  it("every module's rules agree", () => {
    const fam = { ownerId: "anna", householdId: FAMILY_HH, visibility: "household" as const, sensitive: false, graphId: G.family };
    for (const v of [saraEditor, annaWork]) {
      expect(canSee(v, fam)).toBe(false);
      expect(canModify(v, fam)).toBe(false);
      expect(canReadPage(v, fam)).toBe(false);
      expect(canSeeItem(v, fam)).toBe(false);
      expect(canManageReminder(v, fam)).toBe(false);
      expect(canReadSourceRow(v, fam)).toBe(false);
      expect(canEditSourceRow(v, fam)).toBe(false);
    }
    const shared = { ...fam, graphId: G.forSara };
    expect(canSee(saraEditor, shared)).toBe(true);
    expect(canReadPage(saraEditor, shared)).toBe(true);
    expect(canSeeItem(saraEditor, shared)).toBe(true);
    expect(canReadSourceRow(saraEditor, shared)).toBe(true);
  });
  it("SQL filters always pin the graph", () => {
    for (const v of [annaFamily, saraEditor, emmaFamily]) {
      const q = render(nodeReadSql(ctxFor(v), "n"));
      expect(q.sql).toContain(`"n".graph_id = $1`);
      expect(q.params[0]).toBe(v.graphId);
      expect(render(sourceReadSql(ctxFor(v), "s")).sql).toContain(`"s".graph_id =`);
    }
  });
  it("writes may only connect things in one graph", () => {
    expect(assertSameGraph([G.forSara, G.forSara])).toBe(true);
    expect(assertSameGraph([G.forSara, G.family])).toBe(false);
    expect(assertSameGraph([G.forSara, null])).toBe(false);
  });
});

describe("visibility inside a non-family graph", () => {
  it("household = every member, parents = owner and editors, private = only whoever added it", () => {
    const parents = item(G.forSara, { visibility: "parents" });
    const priv = item(G.forSara, { visibility: "private" });
    expect(canReadItem(ctxFor(saraEditor), parents)).toBe(true);
    expect(canReadItem(ctxFor(saraViewer), parents)).toBe(false);
    expect(canReadItem(ctxFor(saraViewer), item(G.forSara))).toBe(true);
    expect(canReadItem(ctxFor(saraEditor), priv)).toBe(false);
    expect(canReadItem(ctxFor(annaForSara), priv)).toBe(true);
  });
});

describe("viewers cannot write", () => {
  it("not even their own items, and the SQL says no", () => {
    const own = item(G.forSara, { ownerId: "sara" });
    expect(canEditItem(ctxFor(saraViewer), own)).toBe(false);
    expect(canEditItem(ctxFor(saraEditor), own)).toBe(true);
    expect(render(nodeEditSql(ctxFor(saraViewer), "n")).sql).toBe("false");
    expect(canEditPage(saraViewer, { ownerId: "sara", householdId: FAMILY_HH, visibility: "household", graphId: G.forSara })).toBe(false);
    expect(canModify(saraViewer, own)).toBe(false);
    expect(canManageReminder(saraViewer, { ownerId: "sara", householdId: FAMILY_HH, graphId: G.forSara })).toBe(false);
  });
});

describe("family graph rules are unchanged", () => {
  it("children: household yes, parents-only no, others' sensitive no, and they still write", () => {
    const ctx = ctxFor(emmaFamily);
    expect(canReadItem(ctx, item(G.family))).toBe(true);
    expect(canReadItem(ctx, item(G.family, { visibility: "parents" }))).toBe(false);
    expect(canReadItem(ctx, item(G.family, { sensitive: true }))).toBe(false);
    expect(canEditItem(ctx, item(G.family, { ownerId: "emma" }))).toBe(true);
    expect(ctx.canWrite).toBe(true);
  });
  it("parents see parents-only; guests only shares", () => {
    expect(canReadItem(ctxFor(mikkelFamily), item(G.family, { visibility: "parents" }))).toBe(true);
    const guest = viewer("gina", FAMILY_HH, "guest", family, "viewer");
    expect(canReadItem(ctxFor(guest), item(G.family))).toBe(false);
    expect(canReadItem(ctxFor(guest), item(G.family), [{ canEdit: false, expiresAt: null }])).toBe(true);
    expect(canEditItem(ctxFor(guest), item(G.family), [{ canEdit: true, expiresAt: null }])).toBe(true);
  });
  it("child cards only exist in the family graph", () => {
    const kids = [{ id: "emma" }, { id: "noah" }];
    expect(visibleChildren(mikkelFamily, kids)).toHaveLength(2);
    expect(visibleChildren(emmaFamily, kids)).toEqual([{ id: "emma" }]);
    expect(visibleChildren(annaWork, kids)).toEqual([]);
  });
});

describe("managing graphs", () => {
  const now = new Date("2026-11-03T12:00:00Z");
  it("picks the requested graph only when you're in it", () => {
    const mine = [
      { id: G.work, kind: "work" as const, householdId: FAMILY_HH, archivedAt: null },
      { id: G.family, kind: "family" as const, householdId: FAMILY_HH, archivedAt: null },
      { id: "archived", kind: "other" as const, householdId: FAMILY_HH, archivedAt: now },
    ];
    expect(pickGraph(mine, FAMILY_HH, G.work)?.id).toBe(G.work);
    expect(pickGraph(mine, FAMILY_HH, "someone-elses")?.id).toBe(G.family);
    expect(pickGraph(mine, FAMILY_HH, "archived")?.id).toBe(G.family);
    expect(pickGraph(mine, FAMILY_HH, null)?.id).toBe(G.family);
    expect(pickGraph([{ id: G.forSara, kind: "shared" as const, householdId: FAMILY_HH, archivedAt: null }], SARA_HH, null)?.id).toBe(G.forSara);
    expect(pickGraph([], SARA_HH, null)).toBeNull();
    // Sara (no family graph) starts in the graph Anna shared with her, not her own empty Personal graph.
    const saras = [
      { id: G.saraPersonal, kind: "personal" as const, householdId: SARA_HH, archivedAt: null },
      { id: G.forSara, kind: "shared" as const, householdId: FAMILY_HH, archivedAt: null },
    ];
    expect(pickGraph(saras, SARA_HH, null)?.id).toBe(G.forSara);
    expect(pickGraph(saras, SARA_HH, G.saraPersonal)?.id).toBe(G.saraPersonal);
    // A forged id for a graph she isn't in falls back the same way.
    expect(pickGraph(saras, SARA_HH, G.family)?.id).toBe(G.forSara);
  });
  it("archiving: never the family graph, never your last graph", () => {
    expect(archiveProblem({ kind: "family", archivedAt: null }, 3)).toMatch(/family/);
    expect(archiveProblem({ kind: "work", archivedAt: null }, 1)).toMatch(/last/);
    expect(archiveProblem({ kind: "work", archivedAt: null }, 2)).toBeNull();
  });
  it("members: owner manages, owner can't leave, anyone else can", () => {
    const base = { graphKind: "shared" as const, targetRole: "editor" as const };
    expect(memberChangeProblem({ ...base, actorId: "anna", actorRole: "owner", targetId: "sara", action: "remove" })).toBeNull();
    expect(memberChangeProblem({ ...base, actorId: "sara", actorRole: "editor", targetId: "sara", action: "remove" })).toBeNull();
    expect(memberChangeProblem({ ...base, actorId: "sara", actorRole: "editor", targetId: "bo", action: "remove" })).toMatch(/owner/);
    expect(memberChangeProblem({ ...base, actorId: "anna", actorRole: "owner", targetId: "anna", targetRole: "owner", action: "remove" })).toMatch(/can't leave/);
    expect(memberChangeProblem({ ...base, actorId: "anna", actorRole: "owner", targetId: "sara", action: "role", newRole: "viewer" })).toBeNull();
    expect(memberChangeProblem({ ...base, actorId: "sara", actorRole: "editor", targetId: "bo", action: "role", newRole: "viewer" })).toMatch(/owner/);
    expect(memberChangeProblem({ graphKind: "family", targetRole: "viewer", actorId: "anna", actorRole: "owner", targetId: "emma", action: "remove" })).toMatch(/Family settings/);
    expect(memberChangeProblem({ ...base, targetRole: null, actorId: "anna", actorRole: "owner", targetId: "x", action: "remove" })).toMatch(/isn't in/);
  });
  it("invite states", () => {
    const future = new Date(now.getTime() + 1000), past = new Date(now.getTime() - 1000);
    expect(inviteState({ expiresAt: future, acceptedAt: null, revokedAt: null }, now)).toBe("open");
    expect(inviteState({ expiresAt: past, acceptedAt: null, revokedAt: null }, now)).toBe("expired");
    expect(inviteState({ expiresAt: future, acceptedAt: now, revokedAt: null }, now)).toBe("accepted");
    expect(inviteState({ expiresAt: future, acceptedAt: null, revokedAt: now }, now)).toBe("revoked");
  });
});
