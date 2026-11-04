/**
 * The timeline rebuild's progress from its jobs on the queue (pure, unit-tested). The shape is what the Rebuild
 * button shows: how far it is, what it proposed, and whether it is still running.
 */
export type RebuildProgress = {
  status: "running" | "done" | "failed";
  startedBy: string;
  startedAt: string;
  finishedAt: string | null;
  total: number;
  done: number;
  /** Not counted per file on the queue (kept for the button): what was found shows as proposals to review. */
  dates: number;
  threads: number;
  joined: number;
  proposals: number;
  proposedChanges: number;
  skipped: number;
  errors: number;
  muxUp: boolean;
  changeSetIds: string[];
  error: string | null;
};

export type JobCounts = { queued: number; running: number; done: number; failed: number; cancelled: number; lastError: string | null };

export function progressFromCounts(c: JobCounts, ctx: {
  startedAt: Date; startedBy: string; muxUp: boolean; proposed: { ids: string[]; changes: number }; joined: number; now?: Date;
}): RebuildProgress {
  const total = c.queued + c.running + c.done + c.failed + c.cancelled;
  const through = c.done + c.failed + c.cancelled;
  const running = c.queued + c.running > 0;
  // Every file failed: the rebuild failed. Some failed: it is done, with errors counted.
  const failed = !running && total > 0 && c.done === 0 && c.failed > 0;
  return {
    status: running ? "running" : failed ? "failed" : "done",
    startedBy: ctx.startedBy, startedAt: ctx.startedAt.toISOString(), finishedAt: running ? null : (ctx.now ?? new Date()).toISOString(),
    total, done: through, dates: 0, threads: 0, joined: ctx.joined,
    proposals: ctx.proposed.ids.length, proposedChanges: ctx.proposed.changes, skipped: c.cancelled, errors: c.failed,
    muxUp: ctx.muxUp, changeSetIds: ctx.proposed.ids.slice(0, 20), error: failed ? c.lastError ?? "Reading the library failed." : null,
  };
}
