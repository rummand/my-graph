import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, sql } from "@/db";
import { connections, households, sources, users } from "@/db/schema";
import { withCursor, readState } from "@/lib/connectors/state";
import type { RunContext } from "@/lib/connectors/types";
import { viewerFor } from "@/lib/graphs/store";
import type { Viewer } from "@/lib/auth";
import { syncPlugin, type PluginConfig } from "./connector";

/**
 * Against the real database (opt-in: PLUGIN_DB_TESTS=1 npx vitest run src/lib/plugins/plugin.db.test.ts): the RSS
 * example plugin as a "plugin" connection: records become sources with provenance, the cursor is committed with
 * them, a second run brings nothing twice, and someone who isn't the platform admin can't run it.
 */
const enabled = !!process.env.PLUGIN_DB_TESTS;
process.env.CONNECTORS_ALLOW_PRIVATE = "1";
let hh: string, v: Viewer, server: Server, port: number, connectionId: string;
const feed = (n: number) => `<?xml version="1.0"?><rss version="2.0"><channel><title>Skolen</title>${Array.from({ length: n }, (_, i) => `<item><title>Nyhed ${i}</title><guid>g${i}</guid><link>https://skole.example/${i}</link><pubDate>Tue, 0${i + 1} Nov 2026 10:00:00 GMT</pubDate><description>Tekst ${i}</description></item>`).join("")}</channel></rss>`;
let body = feed(2);

function ctxFor(row: typeof connections.$inferSelect, config: PluginConfig): RunContext<PluginConfig> {
  let state = readState(row.state);
  const log: string[] = [];
  return {
    viewer: v, connection: row, runId: crypto.randomUUID(), config, secrets: {}, now: new Date(), signal: new AbortController().signal,
    state: () => state,
    async commit(stream, cursor, write) {
      const next = withCursor(state, stream, cursor);
      await db.transaction(async (tx) => { await write(tx); await tx.update(connections).set({ state: next as Record<string, unknown> }).where(eq(connections.id, row.id)); });
      state = next;
    },
    count() {}, log: (l) => { log.push(l); }, proposed() {}, async throttle() {},
  };
}

describe.skipIf(!enabled)("a plugin connection (database)", () => {
  beforeAll(async () => {
    const [h] = await db.insert(households).values({ name: "plugin-check" }).returning(); hh = h.id;
    const email = `admin${Date.now()}@x.test`;
    process.env.PLATFORM_ADMIN_EMAILS = email;
    const [u] = await db.insert(users).values({ householdId: hh, email, name: "Admin", role: "owner" }).returning();
    v = (await viewerFor({ id: u.id, householdId: hh, name: "Admin", email, role: "owner" as const, personNodeId: null }))!;
    server = createServer((_q, res) => { res.writeHead(200, { "content-type": "application/rss+xml" }); res.end(body); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as { port: number }).port;
    connectionId = crypto.randomUUID();
    await db.insert(connections).values({ id: connectionId, graphId: v.graphId, userId: v.id, connector: "plugin", label: "School news", config: {} });
  });
  afterAll(async () => {
    server?.close();
    if (hh) await db.delete(households).where(eq(households.id, hh));
    await sql.end();
  });

  const config = (): PluginConfig => ({ plugin: "rss", options: JSON.stringify({ url: `http://127.0.0.1:${port}/feed` }), visibility: "household", readDocuments: false });
  const row = async () => (await db.select().from(connections).where(eq(connections.id, connectionId)))[0];

  it("stores records as sources with provenance and commits the cursor with them", async () => {
    await syncPlugin(ctxFor(await row(), config()));
    const stored = await db.select().from(sources).where(and(eq(sources.graphId, v.graphId), eq(sources.connectionId, connectionId)));
    expect(stored).toHaveLength(2);
    expect(stored.every((s) => s.kind === "connector" && s.fetchedAt && s.externalId?.startsWith("plugin:rss:items:") && s.url?.startsWith("https://skole.example/"))).toBe(true);
    const state = (await row()).state as { streams: { items: { cursor: { seen: string[] } } } };
    expect(state.streams.items.cursor.seen).toEqual(expect.arrayContaining(["g0", "g1"]));

    body = feed(3);
    await syncPlugin(ctxFor(await row(), config()));
    expect(await db.select().from(sources).where(eq(sources.connectionId, connectionId))).toHaveLength(3);
  });

  it("refuses to run for someone who isn't the platform admin", async () => {
    process.env.PLATFORM_ADMIN_EMAILS = "someone-else@x.test";
    await expect(syncPlugin(ctxFor(await row(), config()))).rejects.toMatchObject({ kind: "needs_you", code: "pluginAdminOnly" });
    process.env.PLATFORM_ADMIN_EMAILS = v.email;
  });

  it("puts a bad setting to the person, and refuses a private address outside development", async () => {
    await expect(syncPlugin(ctxFor(await row(), { ...config(), options: JSON.stringify({ url: "not a url" }) }))).rejects.toMatchObject({ kind: "needs_you", code: "pluginSettings" });
    process.env.CONNECTORS_ALLOW_PRIVATE = "0";
    const env = process.env as Record<string, string | undefined>;
    const prevEnv = env.NODE_ENV; env.NODE_ENV = "production"; env.MG_PLUGINS_DIR = "examples";
    await expect(syncPlugin(ctxFor(await row(), config()))).rejects.toMatchObject({ kind: "needs_you", code: "badUrl" });
    env.NODE_ENV = prevEnv; delete env.MG_PLUGINS_DIR; process.env.CONNECTORS_ALLOW_PRIVATE = "1";
  });
});
