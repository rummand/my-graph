/**
 * Connections as people see and change them (server-only). A connection belongs to one person and feeds one graph:
 * every read and write here is limited to the viewer's own connections in the viewer's current graph. Secrets are
 * encrypted on the way in and never come back out: the DTO only says which ones are saved.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { changeSets, connectionRuns, connections, sources } from "@/db/schema";
import { audit, type Viewer } from "@/lib/auth";
import { abandonChangeSet, proposeChanges, type ChangeInput } from "@/lib/changes";
import * as gbrain from "@/lib/gbrain";
import { scopeOf } from "@/lib/graphs/pure";
import { deleteSource } from "@/lib/ingest/library";
import { decryptSecrets, encryptSecrets } from "./crypto";
import { ConnectorError } from "./errors";
import { clampEvery } from "./manifest";
import { connectorById, offeredIn } from "./registry";
import { claimOne, runClaimed } from "./run";
import { readState } from "./state";
import type { ConnectionRow, StreamCounts } from "./types";

export class ConnectionError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
  }
}

export type ConnectionStatusView = "ok" | "needs_you" | "error" | "paused" | "running" | "new";

export type ConnectionDTO = {
  id: string; connector: string; label: string; status: ConnectionStatusView;
  /** The plain reason, and an i18n code for it when there is one. */
  detail: string | null; detailCode: string | null;
  config: Record<string, unknown>;
  /** Names of the secrets that are saved ("password", "url"), never their values. */
  secretsSaved: string[];
  everyMinutes: number; nextRunAt: string | null; lastRunAt: string | null; lastOkAt: string | null; createdAt: string;
  counts: { total: number; week: number; waiting: number };
};

export type RunDTO = {
  id: string; status: "running" | "done" | "failed" | "skipped"; startedAt: string; finishedAt: string | null;
  trigger: string; streams: Record<string, StreamCounts>; log: string[]; changeSets: string[]; error: string | null; needsYou: boolean;
};

function assertMayConnect(v: Viewer) {
  if (v.role === "guest") throw new ConnectionError(403, "Guests can't connect accounts.");
  if (!scopeOf(v).canWrite) throw new ConnectionError(403, "You can look at this graph but not connect accounts to it.");
}

async function ownRow(v: Viewer, id: string): Promise<ConnectionRow> {
  const [row] = await db.select().from(connections).where(and(eq(connections.id, id), eq(connections.graphId, v.graphId), eq(connections.userId, v.id))).limit(1);
  if (!row) throw new ConnectionError(404, "This connection doesn't exist, or it isn't yours.");
  return row;
}

function leased(row: ConnectionRow): boolean {
  const until = (row.state as { leaseUntil?: string | null }).leaseUntil;
  return !!until && Date.parse(until) > Date.now();
}

function statusOf(row: ConnectionRow): ConnectionStatusView {
  if (leased(row)) return "running";
  if (row.status === "ok" && !row.lastRunAt) return "new";
  return (["ok", "needs_you", "error", "paused"].includes(row.status) ? row.status : "error") as ConnectionStatusView;
}

function secretNames(row: ConnectionRow): string[] {
  try {
    return Object.entries(decryptSecrets(row.secrets, row.id)).filter(([, v]) => !!v).map(([k]) => k);
  } catch {
    return [];
  }
}

function toDTO(row: ConnectionRow, counts: ConnectionDTO["counts"]): ConnectionDTO {
  const [code, ...rest] = (row.statusDetail ?? "").split("|");
  const hasCode = rest.length > 0 && /^[a-zA-Z]+$/.test(code);
  return {
    id: row.id, connector: row.connector, label: row.label, status: statusOf(row),
    detail: row.statusDetail ? (hasCode ? rest.join("|") : row.statusDetail) : null, detailCode: hasCode ? code : null,
    config: row.config ?? {}, secretsSaved: secretNames(row), everyMinutes: row.everyMinutes,
    nextRunAt: row.nextRunAt?.toISOString() ?? null, lastRunAt: row.lastRunAt?.toISOString() ?? null, lastOkAt: row.lastOkAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(), counts,
  };
}

/** Totals per connection: items stored, stored this week, proposals still waiting for a person. */
async function countsFor(graphId: string, ids: string[]): Promise<Map<string, ConnectionDTO["counts"]>> {
  const out = new Map<string, ConnectionDTO["counts"]>(ids.map((id) => [id, { total: 0, week: 0, waiting: 0 }]));
  if (!ids.length) return out;
  const rows = await db.select({
    id: sources.connectionId,
    total: sql<number>`count(*)::int`,
    week: sql<number>`count(*) filter (where ${sources.fetchedAt} > now() - interval '7 days')::int`,
  }).from(sources).where(and(eq(sources.graphId, graphId), inArray(sources.connectionId, ids))).groupBy(sources.connectionId);
  for (const r of rows) if (r.id && out.has(r.id)) Object.assign(out.get(r.id)!, { total: r.total, week: r.week });
  // Waiting: draft change sets this connection opened (runs) or its messages led to (sources.meta.changeSetId).
  const idList = sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `);
  const waiting = await db.execute<{ cid: string; n: number }>(sql`
    select x.cid::text as cid, count(distinct cs.id)::int as n from (
      select r.connection_id as cid, jsonb_array_elements_text(coalesce(r.counts->'changeSets', '[]'::jsonb)) as csid
        from ${connectionRuns} r where r.graph_id = ${graphId} and r.connection_id in (${idList})
      union all
      select s.connection_id as cid, s.meta->>'changeSetId' as csid
        from ${sources} s where s.graph_id = ${graphId} and s.connection_id in (${idList}) and s.meta ? 'changeSetId'
    ) x join ${changeSets} cs on cs.id::text = x.csid and cs.graph_id = ${graphId} and cs.status = 'draft'
    group by x.cid`).catch(() => [] as { cid: string; n: number }[]);
  for (const r of waiting as unknown as { cid: string; n: number }[]) if (out.has(r.cid)) out.get(r.cid)!.waiting = Number(r.n) || 0;
  return out;
}

export async function listConnections(v: Viewer): Promise<ConnectionDTO[]> {
  const rows = await db.select().from(connections).where(and(eq(connections.graphId, v.graphId), eq(connections.userId, v.id))).orderBy(desc(connections.createdAt));
  const counts = await countsFor(v.graphId, rows.map((r) => r.id));
  return rows.map((r) => toDTO(r, counts.get(r.id)!));
}

export async function getConnection(v: Viewer, id: string): Promise<{ connection: ConnectionDTO; runs: RunDTO[] }> {
  const row = await ownRow(v, id);
  const counts = await countsFor(v.graphId, [id]);
  const runs = await db.select().from(connectionRuns).where(and(eq(connectionRuns.connectionId, id), eq(connectionRuns.graphId, v.graphId)))
    .orderBy(desc(connectionRuns.startedAt)).limit(30);
  return {
    connection: toDTO(row, counts.get(id)!),
    runs: runs.map((r) => {
      const c = (r.counts ?? {}) as { trigger?: string; streams?: Record<string, StreamCounts>; log?: string[]; changeSets?: string[]; needsYou?: boolean };
      return {
        id: r.id, status: r.status, startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null,
        trigger: c.trigger ?? "schedule", streams: c.streams ?? {}, log: c.log ?? [], changeSets: c.changeSets ?? [], error: r.error, needsYou: !!c.needsYou,
      };
    }),
  };
}

/** Connections of this person in this graph that need them (for Today's quiet line). */
export async function connectionsNeedingYou(v: Viewer): Promise<{ id: string; label: string; detail: string | null }[]> {
  const rows = await db.select({ id: connections.id, label: connections.label, detail: connections.statusDetail }).from(connections)
    .where(and(eq(connections.graphId, v.graphId), eq(connections.userId, v.id), eq(connections.status, "needs_you")));
  return rows.map((r) => ({ ...r, detail: r.detail?.includes("|") ? r.detail.split("|").slice(1).join("|") : r.detail }));
}

function parseOrThrow<T>(schema: { safeParse(x: unknown): { success: true; data: T } | { success: false; error: { issues: { message: string }[] } } }, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new ConnectionError(400, r.error.issues[0]?.message ?? "Some fields need fixing.");
  return r.data;
}

async function checkWith(connectorId: string, config: Record<string, unknown>, secrets: Record<string, string>, v: Viewer) {
  const c = connectorById(connectorId)!;
  try {
    await c.check?.(config, secrets);
  } catch (e) {
    if (e instanceof ConnectorError) throw new ConnectionError(400, e.message, e.code);
    throw e;
  }
  const person = config.personNodeId;
  if (typeof person === "string") {
    const n = await gbrain.getNode(v, person).catch(() => null);
    if (!n || n.type !== "person") throw new ConnectionError(400, "Pick someone from this graph.");
  }
}

function cleanSecrets(s: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(s).filter(([, x]) => typeof x === "string" && x.trim()).map(([k, x]) => [k, (x as string).trim()]));
}

/** Start a run in the background (claimed atomically; nothing happens if one is already running). */
export function kick(id: string, graphId: string): void {
  void claimOne(id, graphId).then((row) => (row ? runClaimed(row, "person") : null)).catch((e) => console.error("[connectors] run failed to start", e));
}

export async function createConnection(v: Viewer, input: { connector: string; label?: string; config?: Record<string, unknown>; secrets?: Record<string, unknown>; everyMinutes?: number }): Promise<ConnectionDTO> {
  assertMayConnect(v);
  const c = connectorById(input.connector);
  if (!c || !offeredIn(v.graphKind).includes(c)) throw new ConnectionError(400, "That kind of connection isn't available in this graph.");
  if (c.manifest.status === "coming_soon" || !c.sync) throw new ConnectionError(400, "That connection isn't ready yet.");
  const secrets = cleanSecrets(parseOrThrow(c.manifest.secrets, cleanSecrets(input.secrets ?? {})) as Record<string, unknown>);
  const config = parseOrThrow(c.manifest.config, input.config ?? {}) as Record<string, unknown>;
  await checkWith(c.manifest.id, config, secrets, v);
  Object.assign(config, c.describe?.(config, secrets) ?? {});
  const label = (input.label?.trim() || defaultLabel(c.manifest.id, config)).slice(0, 120);

  const id = crypto.randomUUID();
  const [row] = await db.insert(connections).values({
    id, graphId: v.graphId, userId: v.id, connector: c.manifest.id, label, config,
    secrets: encryptSecrets(secrets, id), state: {}, status: "ok",
    everyMinutes: clampEvery(input.everyMinutes, c.manifest), nextRunAt: new Date(),
  }).returning();
  void audit(v, "connections.create", { type: "connection", id }, { connector: c.manifest.id }).catch(() => {});
  kick(id, v.graphId);
  return toDTO(row, { total: 0, week: 0, waiting: 0 });
}

function defaultLabel(connector: string, config: Record<string, unknown>): string {
  if (connector === "aula_calendar") return "Aula calendar";
  if (connector === "imap") return typeof config.user === "string" ? config.user : "Mailbox";
  return typeof config.feedHost === "string" ? `Calendar from ${config.feedHost}` : "Calendar";
}

export async function updateConnection(v: Viewer, id: string, patch: { label?: string; everyMinutes?: number; config?: Record<string, unknown>; secrets?: Record<string, unknown>; paused?: boolean }): Promise<ConnectionDTO> {
  assertMayConnect(v);
  const row = await ownRow(v, id);
  const c = connectorById(row.connector);
  if (!c) throw new ConnectionError(400, "This kind of connection no longer exists.");
  const set: Partial<typeof connections.$inferInsert> = { updatedAt: new Date() };
  let fixed = false;
  if (patch.label !== undefined) set.label = patch.label.trim().slice(0, 120) || row.label;
  if (patch.everyMinutes !== undefined) set.everyMinutes = clampEvery(patch.everyMinutes, c.manifest);
  let config = row.config ?? {};
  let secrets: Record<string, string> | null = null;
  if (patch.config || patch.secrets) {
    let current: Record<string, string> = {};
    try { current = decryptSecrets(row.secrets, row.id); } catch { /* replaced below */ }
    // Empty secret fields keep what is saved; only typed values replace it.
    const merged = { ...current, ...cleanSecrets(patch.secrets ?? {}) };
    secrets = cleanSecrets(parseOrThrow(c.manifest.secrets, merged) as Record<string, unknown>);
    config = parseOrThrow(c.manifest.config, { ...config, ...(patch.config ?? {}) }) as Record<string, unknown>;
    await checkWith(c.manifest.id, config, secrets, v);
    Object.assign(config, c.describe?.(config, secrets) ?? {});
    set.config = config;
    set.secrets = encryptSecrets(secrets, row.id);
    fixed = true;
  }
  if (patch.paused === true) Object.assign(set, { status: "paused", nextRunAt: null, statusDetail: null });
  else if (patch.paused === false || (fixed && row.status === "needs_you")) Object.assign(set, { status: "ok", nextRunAt: new Date(), statusDetail: null });
  const [updated] = await db.update(connections).set(set).where(and(eq(connections.id, id), eq(connections.graphId, v.graphId), eq(connections.userId, v.id))).returning();
  void audit(v, "connections.update", { type: "connection", id }, { fields: Object.keys(patch) }).catch(() => {});
  if (set.status === "ok" && set.nextRunAt) kick(id, v.graphId);
  const counts = await countsFor(v.graphId, [id]);
  return toDTO(updated, counts.get(id)!);
}

/** Run now. 409 when it is paused or already running. */
export async function runNow(v: Viewer, id: string): Promise<void> {
  assertMayConnect(v);
  const row = await ownRow(v, id);
  if (row.status === "paused") throw new ConnectionError(409, "This connection is paused. Resume it first.");
  const claimed = await claimOne(id, v.graphId);
  if (!claimed) throw new ConnectionError(409, "It's already checking. Give it a moment.");
  void runClaimed(claimed, "person").catch((e) => console.error("[connectors] run failed", e));
}

/**
 * Disconnect. keep=true leaves everything it brought in (the items stay in the library and timeline). keep=false
 * removes its stored items, abandons its proposals that nobody has decided on, and proposes retiring the timeline
 * events it already added (a person delivers that, like any change to the graph).
 */
export async function disconnect(v: Viewer, id: string, opts: { keep: boolean }): Promise<{ removed: number; changeSetId: string | null }> {
  assertMayConnect(v);
  const row = await ownRow(v, id);
  let removed = 0;
  let changeSetId: string | null = null;
  // The proposals its runs opened (read before the runs go with the connection).
  const draftIds = new Set<string>();
  const runs = await db.select({ counts: connectionRuns.counts }).from(connectionRuns).where(and(eq(connectionRuns.connectionId, id), eq(connectionRuns.graphId, v.graphId)));
  for (const r of runs) for (const cs of ((r.counts as { changeSets?: string[] })?.changeSets ?? [])) draftIds.add(cs);
  // Stop it first, so a run in progress stores nothing more (run.ts checks the row inside each commit).
  await db.delete(connections).where(and(eq(connections.id, id), eq(connections.graphId, v.graphId), eq(connections.userId, v.id)));
  if (!opts.keep) {
    const items = await db.select({ id: sources.id, meta: sources.meta }).from(sources)
      .where(and(eq(sources.graphId, v.graphId), eq(sources.connectionId, id), eq(sources.ownerId, v.id)));
    const retire: ChangeInput[] = [];
    for (const it of items) {
      const m = it.meta ?? {};
      if (typeof m.changeSetId === "string") draftIds.add(m.changeSetId);
      if (typeof m.nodeId === "string") {
        const n = await gbrain.getNode(v, m.nodeId).catch(() => null);
        if (n) retire.push({ op: "retireNode", nodeId: n.id, note: `It came from ${row.label}, which was disconnected and its items removed.` });
      }
    }
    for (const cs of draftIds) {
      const [s] = await db.select({ status: changeSets.status }).from(changeSets).where(and(eq(changeSets.id, cs), eq(changeSets.graphId, v.graphId))).limit(1).catch(() => []);
      if (s?.status === "draft") await abandonChangeSet(v, cs).catch(() => false);
    }
    for (const it of items) {
      try {
        await deleteSource(v, it.id);
        removed++;
      } catch { /* already gone or not removable: left in place */ }
    }
    if (retire.length) {
      const res = await proposeChanges(v, {
        title: `Remove ${retire.length} ${retire.length === 1 ? "date" : "dates"} that came from ${row.label}`,
        description: "You disconnected this and chose to remove what it brought in. These were already in the graph, so they wait for you.",
        origin: "connector", forUserId: v.id, changes: retire,
      }).catch(() => null);
      changeSetId = res?.id ?? null;
    }
  }
  void audit(v, "connections.disconnect", { type: "connection", id }, { connector: row.connector, keep: opts.keep, removed }).catch(() => {});
  return { removed, changeSetId };
}

/** How much a connection has brought in, for the disconnect dialog. */
export async function importedCount(v: Viewer, id: string): Promise<number> {
  await ownRow(v, id);
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(sources).where(and(eq(sources.graphId, v.graphId), eq(sources.connectionId, id)));
  return r?.n ?? 0;
}

export { readState };
