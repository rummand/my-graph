import { describe, expect, it } from "vitest";
import { progressFromCounts, type JobCounts } from "./rebuild-progress";

const c = (x: Partial<JobCounts>): JobCounts => ({ queued: 0, running: 0, done: 0, failed: 0, cancelled: 0, lastError: null, ...x });
const ctx = { startedAt: new Date("2026-11-04T10:00:00Z"), startedBy: "Anna", muxUp: true, proposed: { ids: [], changes: 0 }, joined: 0, now: new Date("2026-11-04T10:05:00Z") };

describe("timeline rebuild progress from the queue", () => {
  it("is running while any job waits or runs", () => {
    const p = progressFromCounts(c({ queued: 3, running: 2, done: 5 }), ctx);
    expect(p).toMatchObject({ status: "running", total: 10, done: 5, finishedAt: null });
  });

  it("is done when all are through, with failures counted and proposals linked", () => {
    const p = progressFromCounts(c({ done: 8, failed: 1, cancelled: 1 }), { ...ctx, proposed: { ids: ["cs1", "cs2"], changes: 7 }, joined: 2 });
    expect(p).toMatchObject({ status: "done", total: 10, done: 10, errors: 1, skipped: 1, proposals: 2, proposedChanges: 7, changeSetIds: ["cs1", "cs2"], joined: 2, error: null });
    expect(p.finishedAt).toBe("2026-11-04T10:05:00.000Z");
  });

  it("failed only when nothing could be read", () => {
    expect(progressFromCounts(c({ failed: 3, lastError: "mux down" }), ctx)).toMatchObject({ status: "failed", error: "mux down" });
  });

  it("an empty library is simply done", () => {
    expect(progressFromCounts(c({}), ctx)).toMatchObject({ status: "done", total: 0, done: 0 });
  });
});
