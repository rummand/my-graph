/**
 * The reading queue as a viewer sees it, and what they may do with it. Server-only.
 * Only the viewer's current graph, and only jobs for files the viewer may open (others' private files appear as
 * counts, never by name). Retry, cancel and resume need write access to the graph.
 */
import { and, desc, eq, gt, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { jobs, sources } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { accessContext } from "@/lib/gbrain";
import { scopeOf } from "@/lib/graphs/pure";
import { sourceVisibleTo } from "@/lib/ingest/access";
import { IngestError } from "@/lib/ingest/errors";
import { enqueueJob, enqueueSourceRead, kickWorker, requeueOrphans } from "./queue";
import type { JobProgress, JobStatus } from "./policy";
import { workerState } from "./worker";

export type JobView = {
  id: string; kind: string; status: JobStatus; sourceId: string | null; title: string | null; mime: string | null;
  progress: JobProgress | null; attempts: number; maxAttempts: number; error: string | null; heavy: boolean;
  runAfter: string; startedAt: string | null; finishedAt: string | null; createdAt: string;
};

export type QueueView = {
  /** How many run at once (and how many of those may be OCR, image or audio work). */
  concurrency: { total: number; heavy: number };
  workerUp: boolean;
  running: JobView[];
  queued: { count: number; next: JobView[] };
  /** Gave up (or retries are waiting after a failure: those are in `queued` with an error). */
  failed: JobView[];
  /** Files left waiting or half-read with no job (before a restart picked them up). */
  stalled: number;
  /** Work in this graph on files the viewer can't open. */
  hidden: { running: number; queued: number };
  doneLastHour: number;
  canManage: boolean;
};

const iso = (x: Date | null) => (x ? x.toISOString() : null);

const cols = {
  id: jobs.id, kind: jobs.kind, status: jobs.status, sourceId: jobs.subjectId, title: sources.title, mime: sources.mime,
  progress: jobs.progress, attempts: jobs.attempts, maxAttempts: jobs.maxAttempts, error: jobs.error, heavy: jobs.heavy,
  runAfter: jobs.runAfter, startedAt: jobs.startedAt, finishedAt: jobs.finishedAt, createdAt: jobs.createdAt,
};
type Row = {
  id: string; kind: string; status: string; sourceId: string | null; title: string | null; mime: string | null; progress: JobProgress | null;
  attempts: number; maxAttempts: number; error: string | null; heavy: boolean; runAfter: Date; startedAt: Date | null; finishedAt: Date | null; createdAt: Date;
};
const view = (r: Row): JobView => ({
  id: r.id, kind: r.kind, status: r.status as JobStatus, sourceId: r.sourceId, title: r.title, mime: r.mime, progress: r.progress,
  attempts: r.attempts, maxAttempts: r.maxAttempts, error: r.error, heavy: r.heavy,
  runAfter: r.runAfter.toISOString(), startedAt: iso(r.startedAt), finishedAt: iso(r.finishedAt), createdAt: r.createdAt.toISOString(),
});

/** The viewer's graph: what is being read now, what waits, what failed. */
export async function graphQueue(v: Viewer): Promise<QueueView> {
  const w = workerState();
  const empty: QueueView = {
    concurrency: w.cap, workerUp: w.up, running: [], queued: { count: 0, next: [] }, failed: [], stalled: 0,
    hidden: { running: 0, queued: 0 }, doneLastHour: 0, canManage: false,
  };
  if (!(await accessContext(v)).active) return empty;
  const inGraph = eq(jobs.graphId, v.graphId);
  const visible = sourceVisibleTo(v);
  const base = () => db.select(cols).from(jobs).innerJoin(sources, eq(sources.id, jobs.subjectId));

  const [running, next, failed, counts, stalled] = await Promise.all([
    base().where(and(inGraph, eq(jobs.status, "running"), visible)).orderBy(jobs.startedAt).limit(50),
    base().where(and(inGraph, eq(jobs.status, "queued"), visible)).orderBy(desc(jobs.priority), jobs.runAfter, jobs.createdAt).limit(8),
    // Gave up, recently, and nothing newer has been queued for the same file since.
    base().where(and(inGraph, eq(jobs.status, "failed"), visible, gt(jobs.finishedAt, sql`now() - interval '14 days'`),
      sql`not exists (select 1 from jobs n where n.subject_id = ${jobs.subjectId} and n.created_at > ${jobs.createdAt})`))
      .orderBy(desc(jobs.finishedAt)).limit(20),
    db.select({
      queuedVisible: sql<number>`count(*) filter (where ${jobs.status} = 'queued' and ${visible})::int`,
      queuedAll: sql<number>`count(*) filter (where ${jobs.status} = 'queued')::int`,
      runningVisible: sql<number>`count(*) filter (where ${jobs.status} = 'running' and ${visible})::int`,
      runningAll: sql<number>`count(*) filter (where ${jobs.status} = 'running')::int`,
      doneLastHour: sql<number>`count(*) filter (where ${jobs.status} = 'done' and ${jobs.finishedAt} > now() - interval '1 hour' and ${visible})::int`,
    }).from(jobs).innerJoin(sources, eq(sources.id, jobs.subjectId)).where(and(inGraph, inArray(jobs.status, ["queued", "running", "done"]))),
    stalledCount(v),
  ]);
  const c = counts[0] ?? { queuedVisible: 0, queuedAll: 0, runningVisible: 0, runningAll: 0, doneLastHour: 0 };
  return {
    concurrency: w.cap, workerUp: w.up,
    running: running.map(view),
    queued: { count: c.queuedVisible, next: next.map(view) },
    failed: failed.map(view),
    stalled,
    hidden: { running: Math.max(0, c.runningAll - c.runningVisible), queued: Math.max(0, c.queuedAll - c.queuedVisible) },
    doneLastHour: c.doneLastHour,
    canManage: scopeOf(v).canWrite,
  };
}

/** Sources in the viewer's graph (that they may open) left waiting or half-read with no job. */
const stalledWhere = (v: Viewer): SQL => and(eq(sources.graphId, v.graphId), sourceVisibleTo(v), inArray(sources.status, ["pending", "processing"]),
  sql`coalesce((${sources.meta}->>'unread')::boolean, false) = false`,
  sql`not exists (select 1 from jobs j where j.subject_id = ${sources.id} and j.status in ('queued', 'running'))`)!;

async function stalledSources(v: Viewer, limit: number): Promise<{ id: string; ownerId: string; hasFile: boolean }[]> {
  return db.select({ id: sources.id, ownerId: sources.ownerId, hasFile: sql<boolean>`${sources.storageKey} is not null` }).from(sources)
    .where(stalledWhere(v)).limit(limit);
}

async function stalledCount(v: Viewer): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(sources).where(stalledWhere(v));
  return r?.n ?? 0;
}

function assertCanManage(v: Viewer) {
  if (!scopeOf(v).canWrite) throw new IngestError(403, "You can look at this graph but not change what is being read.");
}

/** A job of the viewer's graph, on a file they may open; 404 otherwise (never says another graph's job exists). */
async function manageableJob(v: Viewer, id: string) {
  assertCanManage(v);
  const [j] = await db.select({ job: jobs }).from(jobs).innerJoin(sources, eq(sources.id, jobs.subjectId))
    .where(and(eq(jobs.id, id), eq(jobs.graphId, v.graphId), sourceVisibleTo(v))).limit(1);
  if (!j) throw new IngestError(404, "That item isn't in this graph's reading queue.");
  return j.job;
}

/** "Resume all stalled": jobs cut off by a restart go back to the queue; files with no job get one. */
export async function resumeStalled(v: Viewer): Promise<{ requeued: number; queued: number }> {
  assertCanManage(v);
  if (!(await accessContext(v)).active) throw new IngestError(403, "Your access to this graph has ended.");
  const requeued = await requeueOrphans();
  let queued = 0;
  for (const s of await stalledSources(v, 2000)) {
    const r = await enqueueSourceRead(s.ownerId, s.id, { fromFile: s.hasFile, priority: 5 });
    if (r?.created) queued++;
  }
  kickWorker();
  return { requeued, queued };
}

/** Try a failed or cancelled job again, now, with fresh attempts. Runs as the person who added the file. */
export async function retryJob(v: Viewer, id: string): Promise<{ id: string }> {
  const j = await manageableJob(v, id);
  if (j.status === "queued") {
    await db.update(jobs).set({ runAfter: new Date(), updatedAt: new Date() }).where(eq(jobs.id, j.id));
    kickWorker();
    return { id: j.id };
  }
  if (j.status === "running") throw new IngestError(409, "It is being read right now.");
  await db.update(sources).set({ status: "pending", error: null }).where(and(eq(sources.id, j.subjectId!), inArray(sources.status, ["failed", "pending"])));
  const r = await enqueueJob({
    graphId: j.graphId, userId: j.userId, kind: j.kind as "ingest.read" | "ingest.rebuild", subjectId: j.subjectId,
    payload: j.payload, priority: 20, heavy: j.heavy, maxAttempts: j.maxAttempts,
  });
  return { id: r.id };
}

/** Take a waiting job out of the queue. The file is kept, marked as not read, and can be read again later. */
export async function cancelJob(v: Viewer, id: string): Promise<{ ok: true }> {
  const j = await manageableJob(v, id);
  if (j.status === "running") throw new IngestError(409, "It is already being read, so it can't be taken out of the queue now.");
  if (j.status !== "queued") throw new IngestError(409, "It isn't waiting in the queue any more.");
  const rows = await db.update(jobs).set({ status: "cancelled", finishedAt: new Date(), error: `Taken out of the queue by ${v.name}.`, updatedAt: new Date() })
    .where(and(eq(jobs.id, j.id), eq(jobs.status, "queued"))).returning({ id: jobs.id });
  if (!rows.length) throw new IngestError(409, "It has just started being read.");
  if (j.subjectId) {
    await db.update(sources).set({ status: "failed", error: "Taken out of the reading queue. Read it again to read it." })
      .where(and(eq(sources.id, j.subjectId), inArray(sources.status, ["pending", "processing"]),
        sql`not exists (select 1 from jobs r where r.subject_id = ${j.subjectId} and r.status = 'running')`));
  }
  return { ok: true };
}

/**
 * "Rebuild the timeline from the library" through the queue: one light `ingest.rebuild` job per file of the viewer's
 * graph that they may open (each re-reads only what is still missing; see ingest/classify rebuildNeeds), run after
 * new uploads. Survives restarts like any other job. Returns how many were queued.
 */
export async function queueRebuild(v: Viewer): Promise<number> {
  assertCanManage(v);
  if (!(await accessContext(v)).active) throw new IngestError(403, "Your access to this graph has ended.");
  const rows = await db.select({ id: sources.id }).from(sources)
    .where(and(eq(sources.graphId, v.graphId), sourceVisibleTo(v), sql`${sources.kind} in ('upload', 'email', 'manual', 'sync', 'web', 'connector')`))
    .orderBy(sources.createdAt).limit(10_000);
  let n = 0;
  for (const r of rows) {
    const out = await enqueueJob({ graphId: v.graphId, userId: v.id, kind: "ingest.rebuild", subjectId: r.id, priority: -10, maxAttempts: 2 });
    if (out.created) n++;
  }
  return n;
}
