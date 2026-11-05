/**
 * The in-process worker that drains the job queue. Server-only; started once from src/instrumentation.ts.
 * - polls every few seconds (and wakes at once when this process queues something);
 * - runs up to INGEST_CONCURRENCY jobs at once, at most INGEST_HEAVY_CONCURRENCY of them heavy (OCR, vision, audio);
 * - on start: takes back jobs left running by a stopped server, then queues sources a restart left half-read;
 * - renews each running job's lease, and records its progress;
 * - SIGTERM/SIGINT: stops claiming, shortens the running jobs' leases to a few seconds, lets them finish meanwhile,
 *   then puts the rest back in the queue (if Next.js has not exited first: then the short lease hands them over).
 */
import { claimFilter, concurrencyFrom, HEARTBEAT_MS, POLL_MS, SHUTDOWN_GRACE_MS, type JobProgress } from "./policy";
import { backfillSources, claimNext, heartbeat, markDone, markFailed, releaseJob, requeueOrphans, setKick, shortenLeases, WORKER_ID, type JobRow } from "./queue";
import { HANDLERS } from "./handlers";

type State = {
  started: boolean; stopping: boolean; released: Set<string>;
  running: Map<string, { heavy: boolean; promise: Promise<void> }>;
  timer: ReturnType<typeof setInterval> | null; ticking: boolean; again: boolean; lastSweep: number; lastTickAt: number;
};
const g = globalThis as unknown as { __jobsWorker?: State };

export const CAP = concurrencyFrom(process.env);

export function workerState(): { up: boolean; running: number; cap: { total: number; heavy: number } } {
  const s = g.__jobsWorker;
  return { up: !!s?.started && !s.stopping && Date.now() - s.lastTickAt < POLL_MS * 10, running: s?.running.size ?? 0, cap: CAP };
}

class Released extends Error {
  constructor() { super("The server is restarting; it will be read again when it is back."); }
}

export function startWorker(): void {
  if (g.__jobsWorker?.started) return;
  const s: State = (g.__jobsWorker = {
    started: true, stopping: false, released: new Set(), running: new Map(), timer: null, ticking: false, again: false, lastSweep: 0, lastTickAt: Date.now(),
  });

  void (async () => {
    try {
      const back = await requeueOrphans();
      const queued = await backfillSources();
      if (back || queued) console.log(`[jobs] resumed ${back} interrupted job(s), queued ${queued} waiting source(s)`);
    } catch (e) {
      console.error("[jobs] startup recovery failed:", e instanceof Error ? e.message : e);
    }
    s.lastSweep = Date.now();
    console.log(`[jobs] worker ${WORKER_ID} started: ${CAP.total} at a time (${CAP.heavy} heavy)`);
    setKick(() => void tick(s));
    s.timer = setInterval(() => void tick(s), POLL_MS);
    s.timer.unref?.();
    void tick(s);
  })();

  const onSignal = () => void shutdown(s);
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
}

async function tick(s: State): Promise<void> {
  if (s.stopping) return;
  if (s.ticking) { s.again = true; return; }
  s.ticking = true;
  s.lastTickAt = Date.now();
  try {
    if (Date.now() - s.lastSweep > HEARTBEAT_MS) {
      s.lastSweep = Date.now();
      await requeueOrphans();
    }
    for (;;) {
      if (s.stopping) break;
      const heavyRunning = [...s.running.values()].filter((r) => r.heavy).length;
      const filter = claimFilter({ total: s.running.size, heavy: heavyRunning }, CAP);
      if (filter === "none") break;
      const job = await claimNext(filter === "light", Object.keys(HANDLERS));
      if (!job) break;
      const promise = run(s, job).finally(() => {
        s.running.delete(job.id);
        void tick(s);
      });
      s.running.set(job.id, { heavy: job.heavy, promise });
    }
  } catch (e) {
    console.error("[jobs] poll failed:", e instanceof Error ? e.message : e);
  } finally {
    s.ticking = false;
    if (s.again) { s.again = false; void tick(s); }
  }
}

async function run(s: State, job: JobRow): Promise<void> {
  const handler = HANDLERS[job.kind];
  let lost = false;
  let last: JobProgress | null = null;
  let lastWrite = 0;
  const beat = setInterval(() => {
    if (s.stopping) return; // let the lease run out instead of renewing it
    void heartbeat(job.id, last ?? undefined).then((ok) => { if (!ok) lost = true; }).catch(() => {});
  }, HEARTBEAT_MS);
  beat.unref?.();

  const progress = async (p: JobProgress) => {
    if (s.released.has(job.id) || lost) throw new Released();
    const stepChanged = p.step !== last?.step || p.total !== last?.total;
    last = p;
    if (!stepChanged && Date.now() - lastWrite < 1500) return;
    lastWrite = Date.now();
    if (!(await heartbeat(job.id, p).catch(() => true))) lost = true;
  };

  try {
    if (!handler) throw Object.assign(new Error(`Unknown kind of job: ${job.kind}`), { permanent: true });
    await handler(job, { progress });
    if (s.released.has(job.id)) return;
    await markDone(job.id);
  } catch (e) {
    if (e instanceof Released || s.released.has(job.id)) return;
    console.warn(`[jobs] ${job.kind} ${job.subjectId ?? job.id} attempt ${job.attempts} failed:`, e instanceof Error ? e.message : e);
    await markFailed(job, e).catch((e2) => console.error("[jobs] could not record failure", e2));
  } finally {
    clearInterval(beat);
  }
}

async function shutdown(s: State): Promise<void> {
  if (s.stopping) return;
  s.stopping = true;
  if (s.timer) clearInterval(s.timer);
  setKick(undefined);
  const running = [...s.running.entries()];
  if (!running.length) return;
  console.log(`[jobs] stopping: ${running.length} job(s) running, waiting up to ${SHUTDOWN_GRACE_MS / 1000}s`);
  const work = drain(s, running);
  // Next.js exits as soon as its server has closed. Hold that exit (at most the grace period and a little) so
  // running jobs can finish or be put back in the queue; then exit as Next.js asked.
  const exit = process.exit.bind(process);
  process.exit = ((code?: number) => {
    const cap = new Promise((r) => setTimeout(r, SHUTDOWN_GRACE_MS + 3000));
    void Promise.race([work, cap]).finally(() => exit(code));
  }) as typeof process.exit;
  await work;
}

async function drain(s: State, running: [string, { promise: Promise<void> }][]): Promise<void> {
  // If this process is killed before it can hand the jobs back, the leases still lapse within seconds.
  await shortenLeases(running.map(([id]) => id), SHUTDOWN_GRACE_MS + 5000).catch(() => {});
  await Promise.race([
    Promise.allSettled(running.map(([, r]) => r.promise)),
    new Promise((r) => setTimeout(r, SHUTDOWN_GRACE_MS)),
  ]);
  for (const [id] of running) {
    if (!s.running.has(id)) continue;
    s.released.add(id);
    await releaseJob(id).catch(() => {});
  }
  if (s.released.size) console.log(`[jobs] ${s.released.size} job(s) put back in the queue`);
}
