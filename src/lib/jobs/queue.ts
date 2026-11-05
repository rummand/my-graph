/**
 * The durable job queue (Postgres, no other service). Server-only.
 *   enqueue → a `queued` row (one waiting job per thing: enqueueing again returns the same job)
 *   claim   → `FOR UPDATE SKIP LOCKED`, status `running` with a lease the worker renews while it works
 *   finish  → `done`; failure → back to `queued` after a back-off, or `failed` after max attempts
 *   expired leases (the server restarted) → back to `queued`, not counted as an attempt
 * Who runs it: `userId` in `graphId`, re-checked by the handler when it starts. Rules live in ./policy (pure).
 */
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { jobs, sources } from "@/db/schema";
import {
  afterFailure, afterInterruption, isHeavyMime, LEASE_MS, lockedByDeadLocalWorker, parseWorkerId, selectBackfill, workerId,
  type FailureOutcome, type JobKind, type JobProgress,
} from "./policy";

export type JobRow = typeof jobs.$inferSelect;

/* ── This process's worker identity ──────────────────────────────────────────────────────────────────── */

const gw = globalThis as unknown as { __jobsBoot?: string; __jobsKick?: () => void };
const BOOT = (gw.__jobsBoot ??= randomUUID().slice(0, 8));
export const ME = { host: hostname(), pid: process.pid, boot: BOOT };
export const WORKER_ID = workerId(ME.host, ME.pid, ME.boot);

/** Wake this process's worker so a new job starts without waiting for the next poll. */
export function kickWorker(): void {
  try { gw.__jobsKick?.(); } catch { /* no worker in this process */ }
}
export function setKick(fn: (() => void) | undefined): void {
  gw.__jobsKick = fn;
}

/* ── Enqueue ─────────────────────────────────────────────────────────────────────────────────────────── */

export type EnqueueInput = {
  graphId: string; userId: string; kind: JobKind; subjectId: string | null;
  payload?: Record<string, unknown>; priority?: number; heavy?: boolean; maxAttempts?: number;
};

/** Queue a job; when the same thing already waits, that job is kept (its priority raised if needed). */
export async function enqueueJob(input: EnqueueInput): Promise<{ id: string; created: boolean }> {
  const payload = JSON.stringify(input.payload ?? {});
  const rows = await db.execute<{ id: string; created: boolean }>(sql`
    insert into jobs (graph_id, user_id, kind, subject_id, payload, priority, heavy, max_attempts)
    values (${input.graphId}, ${input.userId}, ${input.kind}, ${input.subjectId}, ${payload}::jsonb, ${input.priority ?? 0},
            ${input.heavy ?? false}, ${input.maxAttempts ?? 3})
    on conflict (kind, subject_id) where status = 'queued'
    do update set priority = greatest(jobs.priority, excluded.priority), payload = excluded.payload,
                  run_after = least(jobs.run_after, now()), updated_at = now()
    returning id, (xmax = 0) as created`);
  kickWorker();
  return { id: rows[0].id, created: !!rows[0].created };
}

/** Queue reading a source (the whole pipeline), as `userId` in the source's graph. */
export async function enqueueSourceRead(
  userId: string, sourceId: string, opts: { fromFile: boolean; priority?: number },
): Promise<{ id: string; created: boolean } | null> {
  const [src] = await db.select({ graphId: sources.graphId, mime: sources.mime }).from(sources).where(eq(sources.id, sourceId)).limit(1);
  if (!src) return null;
  return enqueueJob({
    graphId: src.graphId, userId, kind: "ingest.read", subjectId: sourceId,
    payload: { fromFile: opts.fromFile }, priority: opts.priority ?? 0, heavy: opts.fromFile && isHeavyMime(src.mime),
  });
}

/** Wait until a job is no longer queued or running (or the timeout passes). Returns its last status. */
export async function waitForJob(id: string, timeoutMs = 15 * 60_000): Promise<string | null> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const [j] = await db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, id)).limit(1);
    if (!j || (j.status !== "queued" && j.status !== "running")) return j?.status ?? null;
    if (Date.now() > until) return j.status;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/* ── Claim, heartbeat, finish ────────────────────────────────────────────────────────────────────────── */

type RawJob = Record<string, unknown>;
const d = (x: unknown) => (x == null ? null : x instanceof Date ? x : new Date(String(x)));
function fromRaw(r: RawJob): JobRow {
  return {
    id: String(r.id), graphId: String(r.graph_id), userId: String(r.user_id), kind: String(r.kind),
    subjectId: (r.subject_id as string | null) ?? null, status: String(r.status), heavy: !!r.heavy,
    payload: (typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload ?? {}) as Record<string, unknown>,
    attempts: Number(r.attempts), maxAttempts: Number(r.max_attempts), interruptions: Number(r.interruptions), priority: Number(r.priority),
    runAfter: d(r.run_after)!, leaseUntil: d(r.lease_until), lockedBy: (r.locked_by as string | null) ?? null,
    startedAt: d(r.started_at), finishedAt: d(r.finished_at), progress: (r.progress as JobProgress | null) ?? null,
    error: (r.error as string | null) ?? null, createdAt: d(r.created_at)!, updatedAt: d(r.updated_at)!,
  };
}

const leaseSql = sql.raw(`interval '${Math.round(LEASE_MS / 1000)} seconds'`);

/**
 * Claim the next due job (highest priority, then oldest), skipping rows another worker holds, heavy jobs when
 * `lightOnly`, and things that already have a running job.
 */
export async function claimNext(lightOnly: boolean, kinds?: string[]): Promise<JobRow | null> {
  // Only kinds this process can run: a server started with older code must leave newer kinds to the others.
  const known = kinds?.length ? sql`and j.kind in (${sql.join(kinds.map((k) => sql`${k}`), sql`, `)})` : sql``;
  const rows = await db.execute<RawJob>(sql`
    with next as (
      select j.id from jobs j
      where j.status = 'queued' and j.run_after <= now() ${known}
        and (${!lightOnly}::boolean or j.heavy = false)
        and (j.subject_id is null or not exists (
          select 1 from jobs r where r.subject_id = j.subject_id and r.status = 'running' and r.id <> j.id))
      order by j.priority desc, j.run_after, j.created_at
      for update skip locked
      limit 1
    )
    update jobs set status = 'running', attempts = jobs.attempts + 1, lease_until = now() + ${leaseSql},
      locked_by = ${WORKER_ID}, started_at = now(), finished_at = null, progress = '{"step":"starting"}'::jsonb, updated_at = now()
    from next where jobs.id = next.id
    returning jobs.*`);
  return rows[0] ? fromRaw(rows[0]) : null;
}

/** Renew the lease (and record progress). False when this worker no longer holds the job. */
export async function heartbeat(id: string, progress?: JobProgress): Promise<boolean> {
  const set = progress
    ? sql`lease_until = now() + ${leaseSql}, progress = ${JSON.stringify(progress)}::jsonb, updated_at = now()`
    : sql`lease_until = now() + ${leaseSql}, updated_at = now()`;
  const rows = await db.execute<{ id: string }>(sql`update jobs set ${set} where id = ${id} and locked_by = ${WORKER_ID} and status = 'running' returning id`);
  return rows.length > 0;
}

export async function markDone(id: string): Promise<boolean> {
  const rows = await db.update(jobs).set({ status: "done", finishedAt: new Date(), leaseUntil: null, lockedBy: null, error: null, progress: { step: "done" }, updatedAt: new Date() })
    .where(and(eq(jobs.id, id), eq(jobs.lockedBy, WORKER_ID), eq(jobs.status, "running"))).returning({ id: jobs.id });
  return rows.length > 0;
}

/** Record a failed attempt: retry later, or fail for good (and say so on the source when it was still waiting). */
export async function markFailed(job: JobRow, err: unknown): Promise<FailureOutcome | null> {
  const out = afterFailure(job, err, new Date());
  const set = out.status === "queued"
    ? { status: "queued", runAfter: out.runAfter, error: out.error, leaseUntil: null, lockedBy: null, progress: null, updatedAt: new Date() }
    : { status: "failed", error: out.error, finishedAt: new Date(), leaseUntil: null, lockedBy: null, updatedAt: new Date() };
  try {
    const rows = await db.update(jobs).set(set)
      .where(and(eq(jobs.id, job.id), eq(jobs.lockedBy, WORKER_ID), eq(jobs.status, "running"))).returning({ id: jobs.id });
    if (!rows.length) return null;
  } catch {
    // Another job for the same thing is already waiting (unique "one queued"): this one stops here.
    await db.update(jobs).set({ status: "cancelled", error: out.error, finishedAt: new Date(), leaseUntil: null, lockedBy: null, updatedAt: new Date() })
      .where(and(eq(jobs.id, job.id), eq(jobs.lockedBy, WORKER_ID))).catch(() => {});
    return null;
  }
  if (out.status === "failed") await failSource(job.subjectId, out.error);
  return out;
}

/** A job that gave up leaves its source saying why, instead of "waiting" forever. */
async function failSource(sourceId: string | null, error: string) {
  if (!sourceId) return;
  await db.update(sources).set({ status: "failed", error })
    .where(and(eq(sources.id, sourceId), inArray(sources.status, ["pending", "processing"]))).catch(() => {});
}

/**
 * Shutting down: let this worker's leases run out in `ms` (instead of minutes), so another server takes the jobs
 * over soon even when this process is stopped before it can put them back itself.
 */
export async function shortenLeases(ids: string[], ms: number): Promise<void> {
  if (!ids.length) return;
  await db.update(jobs).set({ leaseUntil: new Date(Date.now() + ms), updatedAt: new Date() })
    .where(and(inArray(jobs.id, ids), eq(jobs.lockedBy, WORKER_ID), eq(jobs.status, "running")));
}

/** Put a job this worker holds back in the queue (shutdown), without counting the attempt. */
export async function releaseJob(id: string): Promise<void> {
  const [j] = await db.select().from(jobs).where(and(eq(jobs.id, id), eq(jobs.lockedBy, WORKER_ID), eq(jobs.status, "running"))).limit(1);
  if (j) await requeueInterrupted(j);
}

async function requeueInterrupted(j: JobRow): Promise<"queued" | "failed" | "skipped"> {
  const out = afterInterruption(j);
  const where = and(eq(jobs.id, j.id), eq(jobs.status, "running"), j.lockedBy ? eq(jobs.lockedBy, j.lockedBy) : sql`locked_by is null`);
  try {
    if (out.status === "failed") {
      const r = await db.update(jobs).set({ status: "failed", error: out.error, interruptions: out.interruptions, finishedAt: new Date(), leaseUntil: null, lockedBy: null, updatedAt: new Date() })
        .where(where).returning({ id: jobs.id });
      if (r.length) await failSource(j.subjectId, out.error);
      return r.length ? "failed" : "skipped";
    }
    const r = await db.update(jobs).set({
      // Its run_after is kept, so it resumes in its old place in the line, before what was queued after it.
      status: "queued", attempts: out.attempts, interruptions: out.interruptions, leaseUntil: null, lockedBy: null,
      progress: null, error: null, updatedAt: new Date(),
    }).where(where).returning({ id: jobs.id });
    return r.length ? "queued" : "skipped";
  } catch {
    // The same thing is already waiting again (e.g. "Read it again" was pressed): this interrupted run is dropped.
    await db.update(jobs).set({ status: "cancelled", finishedAt: new Date(), leaseUntil: null, lockedBy: null, updatedAt: new Date() }).where(where).catch(() => {});
    return "skipped";
  }
}

const pidAlive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};

/**
 * Running jobs whose worker is gone go back to the queue: their lease ran out, or they were held by an earlier
 * server process on this machine that no longer runs (a restart). Returns how many were requeued.
 */
export async function requeueOrphans(): Promise<number> {
  const rows = await db.select().from(jobs).where(eq(jobs.status, "running")).limit(500);
  const now = Date.now();
  let n = 0;
  for (const j of rows) {
    const expired = !j.leaseUntil || j.leaseUntil.getTime() <= now;
    const deadHere = j.lockedBy !== WORKER_ID && lockedByDeadLocalWorker(j.lockedBy, ME, pidAlive);
    if (!expired && !deadHere) continue;
    if (j.lockedBy === WORKER_ID && !expired) continue;
    if ((await requeueInterrupted(j)) === "queued") n++;
  }
  return n;
}

/* ── Backfill: sources left waiting or half-read by a restart get a job ──────────────────────────────── */

/** One pass over every graph. Idempotent: a source with a waiting or running job is left alone. */
export async function backfillSources(limit = 5000): Promise<number> {
  const rows = await db.execute<{ id: string; status: string; kind: string; owner_id: string; has_file: boolean; has_live_job: boolean; unread: boolean }>(sql`
    select s.id, s.status, s.kind, s.owner_id, (s.storage_key is not null) as has_file,
      exists (select 1 from jobs j where j.subject_id = s.id and j.status in ('queued', 'running')) as has_live_job,
      coalesce((s.meta->>'unread')::boolean, false) as unread
    from sources s
    where s.status in ('pending', 'processing')
    order by s.created_at
    limit ${limit}`);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ids = selectBackfill(rows.map((r) => ({ id: r.id, status: r.status, kind: r.kind, hasLiveJob: !!r.has_live_job, unread: !!r.unread })));
  let n = 0;
  for (const id of ids) {
    const r = byId.get(id)!;
    const out = await enqueueSourceRead(r.owner_id, id, { fromFile: !!r.has_file, priority: 0 }).catch((e) => {
      console.warn("[jobs] backfill could not queue", id, e instanceof Error ? e.message : e);
      return null;
    });
    if (out?.created) n++;
  }
  return n;
}

/* ── Viewer actions (permission checks are in ./manage) ──────────────────────────────────────────────── */

export async function getJob(id: string): Promise<JobRow | null> {
  const [j] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  return j ?? null;
}

export async function latestJobFor(subjectId: string): Promise<JobRow | null> {
  const [j] = await db.select().from(jobs).where(eq(jobs.subjectId, subjectId)).orderBy(desc(jobs.createdAt)).limit(1);
  return j ?? null;
}

/** The live job (waiting or running) of each source, for the per-file state in the library. */
export async function liveJobsFor(sourceIds: string[]): Promise<Map<string, LiveJob>> {
  const out = new Map<string, LiveJob>();
  if (!sourceIds.length) return out;
  const rows = await db.select({ subjectId: jobs.subjectId, status: jobs.status, error: jobs.error, attempts: jobs.attempts, progress: jobs.progress })
    .from(jobs).where(and(inArray(jobs.subjectId, sourceIds), inArray(jobs.status, ["queued", "running"])));
  for (const r of rows) {
    if (!r.subjectId) continue;
    const cur = out.get(r.subjectId);
    if (cur?.status === "running") continue; // running wins over a follow-up waiting behind it
    out.set(r.subjectId, { status: r.status as "queued" | "running", error: r.error, attempts: r.attempts, progress: r.progress });
  }
  return out;
}

export type LiveJob = { status: "queued" | "running"; error: string | null; attempts: number; progress: JobProgress | null };

export { parseWorkerId };
