/**
 * The data-safety timer (server-only): every 5 minutes it
 *  - takes the nightly backup when it is due (BACKUP_TIME, default 03:00 in BACKUP_TZ, default Europe/Copenhagen),
 *  - expires export downloads older than 24 hours and recovers exports a restart interrupted,
 *  - carries out account deletions whose 7-day grace period is over (or cancels them when the person signed in).
 * Started once per process (src/instrumentation.ts should call startDataSafetyScheduler(); pages and routes of this
 * workstream also call it, so it runs even before that line is added). Never throws; every error is logged.
 */
import { BackupBusy, readState, runBackup, backupDir } from "./run";
import { backupSettings, lastScheduledAt, scheduledBackupDue } from "./policy";

const TICK_MS = 5 * 60_000;
type State = { started: boolean; timer: ReturnType<typeof setInterval> | null; ticking: boolean };
const g = globalThis as unknown as { __mgDataSafety?: State };

export function startDataSafetyScheduler(): void {
  if (process.env.NEXT_PHASE === "phase-production-build" || process.env.VITEST || process.env.DATA_SAFETY_SCHEDULER === "0") return;
  if (g.__mgDataSafety?.started) return;
  const s: State = (g.__mgDataSafety = { started: true, timer: null, ticking: false });
  const first = setTimeout(() => void tick(s), 30_000);
  first.unref?.();
  s.timer = setInterval(() => void tick(s), TICK_MS);
  s.timer.unref?.();
  console.log("[data-safety] scheduler started (nightly backups, export expiry, account deletions)");
}

export async function tick(s: State = g.__mgDataSafety ?? { started: false, timer: null, ticking: false }): Promise<void> {
  if (s.ticking) return;
  s.ticking = true;
  try {
    await nightlyBackupIfDue().catch((e) => console.error("[data-safety] backup check failed:", e instanceof Error ? e.message : e));
    await import("@/lib/export/jobs").then((m) => m.sweepExports()).catch((e) => console.error("[data-safety] export sweep failed:", e instanceof Error ? e.message : e));
    await import("@/lib/export/deletion").then((m) => m.sweepDeletions()).catch((e) => console.error("[data-safety] deletion sweep failed:", e instanceof Error ? e.message : e));
  } finally {
    s.ticking = false;
  }
}

export async function nightlyBackupIfDue(now = new Date()): Promise<boolean> {
  const settings = backupSettings(process.env);
  if (settings.disabled) return false;
  const state = await readState(backupDir());
  if (state.running && now.getTime() - new Date(state.running.startedAt).getTime() < 6 * 60 * 60_000) return false;
  const slot = lastScheduledAt(now, settings.time, settings.timeZone);
  const nightly = state.history.filter((r) => r.trigger === "nightly");
  const sinceSlot = nightly.filter((r) => new Date(r.startedAt).getTime() >= slot.getTime());
  const last = nightly[0] ?? null;
  // A refused run (no key) is recorded once per night, so the admin page shows why, without retrying all night.
  if (settings.refusal && sinceSlot.length) return false;
  const due = scheduledBackupDue({
    now, time: settings.time, timeZone: settings.timeZone,
    lastAttemptAt: last ? new Date(last.startedAt) : null, lastOk: !!last?.ok, attemptsSinceSchedule: sinceSlot.length,
  });
  if (!due) return false;
  try {
    const r = await runBackup("nightly");
    console.log(`[data-safety] nightly backup ${r.id}: ${r.ok ? "ok" : `failed: ${r.error}`}`);
  } catch (e) {
    if (!(e instanceof BackupBusy)) throw e;
  }
  return true;
}
