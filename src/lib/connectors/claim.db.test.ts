import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, sql } from "@/db";
import { connectionRuns, connections, households, sources, users } from "@/db/schema";
import { viewerFor } from "@/lib/graphs/store";
import { encryptSecrets } from "./crypto";
import { claimDue, claimOne, runClaimed } from "./run";

/**
 * Against the real database (opt-in: CONNECTOR_DB_TESTS=1 npx vitest run src/lib/connectors/claim.db.test.ts):
 * the atomic claim, and a whole ICS run from a local calendar server (ETag, dedupe by UID, update on change).
 */
const enabled = !!process.env.CONNECTOR_DB_TESTS;
process.env.CONNECTORS_ALLOW_PRIVATE = "1";

let hh: string, userId: string, graphId: string, server: Server, port: number;
let body = "";
let etag = '"v1"';
let hits = 0;

const cal = (summary: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:Test\r\nBEGIN:VEVENT\r\nUID:e1@test\r\nDTSTART:20261126T083000Z\r\nSUMMARY:${summary}\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:e2@test\r\nDTSTART;VALUE=DATE:20261223\r\nSUMMARY:Lukkedag\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;

describe.skipIf(!enabled)("connector runs (database)", () => {
  beforeAll(async () => {
    const [h] = await db.insert(households).values({ name: "connector-check" }).returning(); hh = h.id;
    const [u] = await db.insert(users).values({ householdId: hh, email: `c${Date.now()}@x.test`, name: "Rita", role: "owner" }).returning();
    userId = u.id;
    const v = await viewerFor({ id: u.id, householdId: hh, name: "Rita", email: u.email, role: "owner" as const, personNodeId: null });
    graphId = v!.graphId;
    server = createServer((req, res) => {
      hits++;
      if (req.headers["if-none-match"] === etag) { res.writeHead(304); res.end(); return; }
      res.writeHead(200, { "content-type": "text/calendar", etag });
      res.end(body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as { port: number }).port;
  });
  afterAll(async () => {
    server?.close();
    if (hh) await db.delete(households).where(eq(households.id, hh));
    await sql.end();
  });

  async function newConnection(next: Date | null = new Date(Date.now() - 1000)) {
    const id = crypto.randomUUID();
    await db.insert(connections).values({
      id, graphId, userId, connector: "ics", label: "Test calendar", config: { visibility: "private" },
      secrets: encryptSecrets({ url: `http://127.0.0.1:${port}/cal.ics` }, id), nextRunAt: next,
    });
    return id;
  }

  it("claims a connection once, however many ask at the same time", async () => {
    const id = await newConnection();
    const results = await Promise.all([claimOne(id, graphId), claimOne(id, graphId), claimOne(id, graphId)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const due = await claimDue(50);
    expect(due.map((r) => r.id)).not.toContain(id); // leased
    expect(await claimOne(id, crypto.randomUUID())).toBeNull(); // another graph never claims it
    await db.delete(connections).where(eq(connections.id, id));
  });

  it("runs an ICS feed: stores events with the cursor, skips on 304, updates on change", async () => {
    body = cal("Tur i Zoo");
    const id = await newConnection();
    const row = await claimOne(id, graphId);
    const r1 = await runClaimed(row!, "person");
    expect(r1.outcome).toBe("ok");
    const stored = await db.select().from(sources).where(and(eq(sources.graphId, graphId), eq(sources.connectionId, id)));
    expect(stored.map((s) => s.externalId).sort()).toEqual(["ics:e1@test", "ics:e2@test"]);
    expect(stored.every((s) => s.kind === "connector" && s.fetchedAt && s.url === null)).toBe(true);
    let [c] = await db.select().from(connections).where(eq(connections.id, id));
    expect(c.status).toBe("ok");
    expect((c.state as { streams: { events: { cursor: { etag: string } } } }).streams.events.cursor.etag).toBe('"v1"');
    expect((c.state as { leaseUntil: string | null }).leaseUntil).toBeNull();
    expect(c.nextRunAt!.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);

    const before = hits;
    await runClaimed((await claimOne(id, graphId))!, "person");
    expect(hits).toBe(before + 1); // asked, got 304
    expect((await db.select().from(sources).where(eq(sources.connectionId, id))).length).toBe(2);

    body = cal("Tur i Zoo (ny tid)"); etag = '"v2"';
    await runClaimed((await claimOne(id, graphId))!, "person");
    const e1 = (await db.select().from(sources).where(and(eq(sources.connectionId, id), eq(sources.externalId, "ics:e1@test"))))[0];
    expect(e1.title).toBe("Tur i Zoo (ny tid)");
    const runs = await db.select().from(connectionRuns).where(eq(connectionRuns.connectionId, id));
    expect(runs).toHaveLength(3);
    expect(runs.every((r) => r.status === "done")).toBe(true);

    // A link that disappears needs the person; the schedule stops.
    server.removeAllListeners("request");
    server.on("request", (_q, res) => { res.writeHead(404); res.end(); });
    const r4 = await runClaimed((await claimOne(id, graphId))!, "person");
    expect(r4.outcome).toBe("needs_you");
    [c] = await db.select().from(connections).where(eq(connections.id, id));
    expect(c.status).toBe("needs_you");
    expect(c.nextRunAt).toBeNull();
    expect(c.statusDetail).not.toContain("cal.ics");
  });
});
