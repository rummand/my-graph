import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, sql } from "@/db";
import { changeSets, households, nodes, users } from "@/db/schema";
import * as gbrain from "@/lib/gbrain";
import { viewerFor } from "@/lib/graphs/store";
import type { Viewer } from "@/lib/auth";
import { appDeps } from "./deps";
import { handle, type McpContext } from "./tools";

/**
 * Against the real database (opt-in: MCP_DB_TESTS=1 npx vitest run src/lib/mcp-server/mcp.db.test.ts): two households,
 * a key's viewer in one family graph; nothing of the other is readable or linkable; propose_changes only opens a draft.
 */
const enabled = !!process.env.MCP_DB_TESTS;
let hhA: string, hhB: string, a: Viewer, b: Viewer, otherNode: string, ownNode: string;

describe.skipIf(!enabled)("the MCP server against the database", () => {
  beforeAll(async () => {
    const mk = async (name: string) => {
      const [h] = await db.insert(households).values({ name }).returning();
      const [u] = await db.insert(users).values({ householdId: h.id, email: `${name}${Date.now()}@x.test`, name, role: "owner" }).returning();
      const v = await viewerFor({ id: u.id, householdId: h.id, name, email: u.email, role: "owner" as const, personNodeId: null });
      return { h: h.id, v: v as Viewer };
    };
    ({ h: hhA, v: a } = await mk("mcpA"));
    ({ h: hhB, v: b } = await mk("mcpB"));
    const prov = { activity: "manual_edit" as const, agentType: "user" as const, agentId: a.id };
    ownNode = (await gbrain.upsertNode(a, { type: "person", label: "Emma Mcptest", visibility: "household" }, prov)).node.id;
    otherNode = (await gbrain.upsertNode(b, { type: "person", label: "Secret Neighbour", visibility: "household" }, { ...prov, agentId: b.id })).node.id;
  });
  afterAll(async () => {
    for (const h of [hhA, hhB]) if (h) await db.delete(households).where(eq(households.id, h));
    await sql.end();
  });

  const ctx = (scope: "read" | "propose"): McpContext => ({ viewer: a, cred: { kind: "key", id: crypto.randomUUID(), name: "test key", userId: a.id, graphId: a.graphId, scope }, origin: "http://localhost", deps: appDeps });
  const call = async (c: McpContext, name: string, args: unknown) => (await handle(c, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }))!.result as { isError: boolean; structuredContent?: Record<string, unknown> };

  it("reads its own graph and nothing of another household's", async () => {
    const people = (await call(ctx("read"), "list_people", {})).structuredContent!.people as { id: string }[];
    expect(people.map((p) => p.id)).toContain(ownNode);
    expect(people.map((p) => p.id)).not.toContain(otherNode);
    expect((await call(ctx("read"), "get_node", { id: otherNode })).isError).toBe(true);
    const found = (await call(ctx("read"), "search_graph", { query: "Secret Neighbour" })).structuredContent!.things as { id: string }[];
    expect(found.map((t) => t.id)).not.toContain(otherNode);
  });

  it("propose_changes opens a draft and changes nothing in the graph", async () => {
    const before = await db.select({ id: nodes.id }).from(nodes).where(eq(nodes.graphId, a.graphId));
    const r = await call(ctx("propose"), "propose_changes", { title: "Test", changes: [{ op: "addNode", type: "place", label: "Svømmehallen", why: "test" }] });
    expect(r.isError).toBe(false);
    const id = r.structuredContent!.changeSetId as string;
    const [cs] = await db.select().from(changeSets).where(eq(changeSets.id, id));
    expect(cs).toMatchObject({ status: "draft", graphId: a.graphId, origin: "assistant", deliveredAt: null });
    const after = await db.select({ id: nodes.id }).from(nodes).where(eq(nodes.graphId, a.graphId));
    expect(after.length).toBe(before.length);
    const linked = await call(ctx("propose"), "propose_changes", { title: "Link", changes: [{ op: "addEdge", from: ownNode, to: otherNode, relation: "knows", why: "x" }] });
    expect(linked.isError).toBe(true);
    const sets = await db.select().from(changeSets).where(inArray(changeSets.graphId, [b.graphId]));
    expect(sets).toHaveLength(0);
  });
});
