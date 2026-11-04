/**
 * "Rebuild the timeline from the library" (server-only), on the durable job queue: `queueRebuild` (src/lib/jobs) puts
 * one light `ingest.rebuild` job per source of the current graph the viewer may open; each re-reads only what is still
 * missing (its own date, its conversation, what it would add — ingest/classify rebuildNeeds), so running it twice
 * proposes nothing new the second time. Findings arrive as change sets to review; nothing goes into the graph without
 * a person. When the last job of a rebuild is through, mail threads split across uploads are joined.
 *
 * Progress is read from the queue (it survives restarts): the rebuild is the graph's `ingest.rebuild` jobs created
 * since it was started. `rebuildStatus(v)` reads it; `rebuildProgress(v)` (sync, for the existing route) returns the
 * last reading and refreshes it in the background.
 */
import "server-only";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { changeSets, changes, jobs, sources } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { accessContext } from "@/lib/gbrain";
import { scopeOf } from "@/lib/graphs/pure";
import { sourceVisibleTo } from "@/lib/ingest/access";
import { resolveThreads } from "@/lib/ingest/mail";
import { queueRebuild } from "@/lib/jobs";
import * as mux from "@/lib/mux";
import { progressFromCounts, type JobCounts, type RebuildProgress } from "./rebuild-progress";

export type { RebuildProgress } from "./rebuild-progress";

type Batch = { startedAt: Date; startedBy: string; muxUp: boolean; joined: number | null; last: RebuildProgress | null };

const g = globalThis as unknown as { __timelineRebuildBatches?: Map<string, Batch> };
const batches = (g.__timelineRebuildBatches ??= new Map());

/** The rebuild's start: remembered in this process, or (after a restart) the newest burst of rebuild jobs. */
async function batchOf(v: Viewer): Promise<Batch | null> {
  const known = batches.get(v.graphId);
  if (known) return known;
  const [row] = await db.select({ at: sql<Date | null>`max(${jobs.createdAt})` }).from(jobs)
    .where(and(eq(jobs.graphId, v.graphId), eq(jobs.kind, "ingest.rebuild")));
  if (!row?.at) return null;
  const latest = new Date(row.at);
  // queueRebuild enqueues its jobs one after another: they were all created within a few minutes of each other.
  const b: Batch = { startedAt: new Date(latest.getTime() - 15 * 60_000), startedBy: "", muxUp: true, joined: null, last: null };
  batches.set(v.graphId, b);
  return b;
}

async function countsSince(v: Viewer, since: Date): Promise<JobCounts> {
  const rows = await db.select({ status: jobs.status, n: sql<number>`count(*)::int` }).from(jobs)
    .innerJoin(sources, eq(sources.id, jobs.subjectId))
    .where(and(eq(jobs.graphId, v.graphId), eq(jobs.kind, "ingest.rebuild"), gte(jobs.createdAt, since), sourceVisibleTo(v)))
    .groupBy(jobs.status);
  const c: JobCounts = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0, lastError: null };
  for (const r of rows) if (r.status in c) (c as unknown as Record<string, number>)[r.status] = Number(r.n);
  if (c.failed) {
    const [e] = await db.select({ error: jobs.error }).from(jobs)
      .where(and(eq(jobs.graphId, v.graphId), eq(jobs.kind, "ingest.rebuild"), eq(jobs.status, "failed"), gte(jobs.createdAt, since))).limit(1);
    c.lastError = e?.error ?? null;
  }
  return c;
}

/** Change sets the rebuild proposed (the reading pipeline's, in this graph, by this person, since it started). */
async function proposedSince(v: Viewer, since: Date): Promise<{ ids: string[]; changes: number }> {
  const sets = await db.select({ id: changeSets.id }).from(changeSets)
    .where(and(eq(changeSets.graphId, v.graphId), eq(changeSets.origin, "ingest"), eq(changeSets.createdBy, v.id), gte(changeSets.createdAt, since)))
    .orderBy(sql`${changeSets.createdAt} desc`).limit(200);
  if (!sets.length) return { ids: [], changes: 0 };
  const [n] = await db.select({ n: sql<number>`count(*)::int` }).from(changes).where(inArray(changes.changeSetId, sets.map((x) => x.id)));
  return { ids: sets.map((x) => x.id), changes: Number(n?.n ?? 0) };
}

/** The rebuild's progress, from the queue. Null when this graph has never been rebuilt. */
export async function rebuildStatus(v: Viewer): Promise<RebuildProgress | null> {
  const b = await batchOf(v);
  if (!b) return null;
  const [counts, proposed] = await Promise.all([countsSince(v, b.startedAt), proposedSince(v, b.startedAt)]);
  let p = progressFromCounts(counts, { startedAt: b.startedAt, startedBy: b.startedBy, muxUp: b.muxUp, proposed, joined: b.joined ?? 0 });
  // Everything is through: join mail threads once for this rebuild, then say it is done.
  if (p.status !== "running" && b.joined === null) {
    b.joined = await joinThreads(v).catch((e) => { console.error("[timeline rebuild] joining threads", e); return 0; });
    p = { ...p, joined: b.joined };
  }
  b.last = p;
  return p;
}

/** The last reading of the progress (sync), refreshed in the background for the next call. */
export function rebuildProgress(v: Viewer): RebuildProgress | null {
  const b = batches.get(v.graphId);
  void rebuildStatus(v).catch((e) => console.error("[timeline rebuild] status", e));
  return b?.last ?? null;
}

/** Start a rebuild for the viewer's graph through the queue, or return the one already running. */
export async function startRebuild(v: Viewer): Promise<{ progress: RebuildProgress; started: boolean } | { error: string; status: number }> {
  if (!scopeOf(v).canWrite) return { error: "You can look at this graph but not rebuild it.", status: 403 };
  if (!(await accessContext(v)).active) return { error: "Your access to this graph has ended.", status: 403 };
  const cur = await rebuildStatus(v).catch(() => null);
  if (cur?.status === "running") return { progress: cur, started: false };
  let muxUp = false;
  try { muxUp = (await mux.muxHealth()).ok; } catch { muxUp = false; }
  const b: Batch = { startedAt: new Date(Date.now() - 1000), startedBy: v.name, muxUp, joined: null, last: null };
  batches.set(v.graphId, b);
  try {
    await queueRebuild(v);
  } catch (e) {
    batches.delete(v.graphId);
    const status = typeof (e as { status?: unknown }).status === "number" ? (e as { status: number }).status : 500;
    return { error: e instanceof Error ? e.message : "The rebuild couldn't start.", status };
  }
  const progress = (await rebuildStatus(v)) ?? progressFromCounts({ queued: 0, running: 0, done: 0, failed: 0, cancelled: 0, lastError: null }, { startedAt: b.startedAt, startedBy: v.name, muxUp, proposed: { ids: [], changes: 0 }, joined: 0 });
  return { progress, started: true };
}

/** Give every message of a conversation the same thread key, even when its messages came in separate uploads. */
async function joinThreads(v: Viewer): Promise<number> {
  const mail = await db.select({ id: sources.id, threadKey: sources.threadKey, meta: sources.meta }).from(sources)
    .where(and(eq(sources.graphId, v.graphId), sourceVisibleTo(v), sql`(${sources.mime} = 'message/rfc822' or ${sources.kind} = 'email')`)).limit(20_000);
  const msgs = mail.map((m) => {
    const e = ((m.meta ?? {}).email ?? {}) as { messageId?: string | null; inReplyTo?: string | null; references?: string[] };
    return { id: m.id, threadKey: m.threadKey, messageId: e.messageId ?? undefined, inReplyTo: e.inReplyTo ?? undefined, references: Array.isArray(e.references) ? e.references : [] };
  });
  const keys = resolveThreads(msgs);
  let changed = 0;
  for (const m of msgs) {
    if (!m.messageId) continue;
    const k = keys.get(m.messageId.toLowerCase());
    if (k && k !== m.threadKey) {
      await db.update(sources).set({ threadKey: k }).where(eq(sources.id, m.id));
      changed++;
    }
  }
  return changed;
}
