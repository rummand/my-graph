/**
 * The queue's rules, as pure functions (no database), so they can be tested: how many run at once, what may be
 * claimed next, back-off between attempts, when a lease is lost, what a restart-interrupted job becomes, and which
 * sources need a job after a restart (backfill).
 */

export type JobKind = "ingest.read" | "ingest.rebuild" | "clinical.transcribe" | "clinical.draft" | "export.build";
export const JOB_KINDS: JobKind[] = ["ingest.read", "ingest.rebuild", "clinical.transcribe", "clinical.draft", "export.build"];
/** Clinical jobs: their subject is the session's audio or transcript source (sensitive, private to the clinician). */
export const CLINICAL_KINDS: JobKind[] = ["clinical.transcribe", "clinical.draft"];
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";
export const LIVE_STATUSES: JobStatus[] = ["queued", "running"];

/** What a running job is doing, for the queue panel ("Reading the text", "Finding people and dates, part 2 of 5"). */
export type JobProgress = { step: string; done?: number; total?: number; label?: string };

/** A lease is held this long and renewed every HEARTBEAT_MS while the job runs. */
export const LEASE_MS = 3 * 60_000;
export const HEARTBEAT_MS = 30_000;
export const POLL_MS = 3_000;
/** On SIGTERM: running jobs get this long to finish before their lease is let go. */
export const SHUTDOWN_GRACE_MS = 8_000;
/** A job cut off by restarts this many times is failed instead of requeued (it may be what crashes the server). */
export const MAX_INTERRUPTIONS = 5;

export const DEFAULT_CONCURRENCY = 3;
export const DEFAULT_HEAVY_CONCURRENCY = 1;

const intIn = (raw: string | undefined, fallback: number, min: number, max: number) => {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n >= min ? Math.min(n, max) : fallback;
};

/** INGEST_CONCURRENCY (default 3) jobs at once; at most INGEST_HEAVY_CONCURRENCY (default 1) of them OCR/vision/audio. */
export function concurrencyFrom(env: Record<string, string | undefined>): { total: number; heavy: number } {
  const total = intIn(env.INGEST_CONCURRENCY, DEFAULT_CONCURRENCY, 1, 32);
  const heavy = intIn(env.INGEST_HEAVY_CONCURRENCY, Math.min(DEFAULT_HEAVY_CONCURRENCY, total), 1, 32);
  return { total, heavy: Math.min(heavy, total) };
}

/** What the worker may claim now: nothing (all slots busy), anything, or only light jobs (heavy slots busy). */
export function claimFilter(running: { total: number; heavy: number }, cap: { total: number; heavy: number }): "none" | "any" | "light" {
  if (running.total >= cap.total) return "none";
  return running.heavy >= cap.heavy ? "light" : "any";
}

/** OCR, image description (vision), transcription and PDFs (which may be scans) are heavy. */
export function isHeavyMime(mime: string | null | undefined): boolean {
  const m = (mime ?? "").toLowerCase();
  return m.startsWith("image/") || m.startsWith("audio/") || m.startsWith("video/") || m === "application/pdf"
    || m.includes("presentationml");
}

/** Wait before attempt n+1 after n failed attempts: 30 s, 2 min, 8 min, … capped at 30 min. */
export function backoffMs(attempts: number): number {
  const n = Math.max(1, attempts);
  return Math.min(30 * 60_000, 30_000 * 4 ** (n - 1));
}

/** Thrown by a handler when trying again cannot help (file gone, person no longer a member). */
export class PermanentJobError extends Error {
  readonly permanent = true;
}
export const isPermanent = (e: unknown) => !!e && typeof e === "object" && (e as { permanent?: unknown }).permanent === true;

export type FailureOutcome =
  | { status: "queued"; runAfter: Date; error: string }
  | { status: "failed"; error: string };

/** After a failed attempt: back off and try again, or give up with a plain-language reason. */
export function afterFailure(job: { attempts: number; maxAttempts: number }, err: unknown, now: Date): FailureOutcome {
  const reason = plainError(err);
  if (isPermanent(err) || job.attempts >= job.maxAttempts) return { status: "failed", error: reason };
  return { status: "queued", runAfter: new Date(now.getTime() + backoffMs(job.attempts)), error: reason };
}

/** A running job whose lease has run out: its worker stopped (restart, crash). */
export function leaseExpired(job: { status: string; leaseUntil: Date | null }, now: Date): boolean {
  return job.status === "running" && (!job.leaseUntil || job.leaseUntil.getTime() <= now.getTime());
}

/** What a restart-interrupted job becomes: back in the queue (not counted as an attempt), or failed after many. */
export function afterInterruption(job: { attempts: number; interruptions: number }): { status: "queued"; attempts: number; interruptions: number } | { status: "failed"; error: string; interruptions: number } {
  const interruptions = job.interruptions + 1;
  if (interruptions >= MAX_INTERRUPTIONS) {
    return { status: "failed", interruptions, error: `Reading was cut off ${interruptions} times while the server restarted. Try it again, or add the file once more.` };
  }
  return { status: "queued", attempts: Math.max(0, job.attempts - 1), interruptions };
}

/** Worker ids are "host/pid/boot". A job locked by this host under a pid that no longer runs is safe to take back. */
export function workerId(host: string, pid: number, boot: string): string {
  return `${host}/${pid}/${boot}`;
}
export function parseWorkerId(id: string | null | undefined): { host: string; pid: number; boot: string } | null {
  if (!id) return null;
  const m = /^(.*)\/(\d+)\/([^/]+)$/.exec(id);
  return m ? { host: m[1], pid: Number(m[2]), boot: m[3] } : null;
}
export function lockedByDeadLocalWorker(lockedBy: string | null, me: { host: string; pid: number; boot: string }, pidAlive: (pid: number) => boolean): boolean {
  const w = parseWorkerId(lockedBy);
  if (!w || w.host !== me.host) return false;
  if (w.pid === me.pid) return w.boot !== me.boot; // same pid, earlier boot of this process id: gone
  return !pidAlive(w.pid);
}

/** Sources that were waiting, being read, or stalled when the server stopped, and have no job: they need one. */
export type BackfillCandidate = { id: string; status: string; kind: string; hasLiveJob: boolean; unread?: boolean };
const READABLE_KINDS = new Set(["upload", "email", "manual", "sync", "web", "connector", "wiki"]);
export function needsBackfill(s: BackfillCandidate): boolean {
  if (s.hasLiveJob) return false;
  if (s.status !== "pending" && s.status !== "processing") return false;
  if (s.unread) return false; // a link saved without its page: nothing to read
  return READABLE_KINDS.has(s.kind);
}
export const selectBackfill = (rows: BackfillCandidate[]) => rows.filter(needsBackfill).map((r) => r.id);

/** Turn an error into one plain sentence for the queue panel (no stack traces, no SQL). */
export function plainError(err: unknown): string {
  const raw = (err instanceof Error ? err.message : typeof err === "string" ? err : "").trim();
  if (!raw) return "Something went wrong while reading it.";
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up/i.test(raw)) return "A service it needed didn't answer. It will be tried again.";
  if (/^(insert|update|delete|select) |violates|syntax error|relation ".*" does not exist/i.test(raw)) return "The database refused a write while reading it.";
  const one = raw.split("\n")[0].replace(/\s+/g, " ").trim();
  return one.length > 300 ? `${one.slice(0, 297)}…` : one;
}
