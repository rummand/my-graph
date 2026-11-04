import { describe, expect, it } from "vitest";
import {
  afterFailure, afterInterruption, backoffMs, claimFilter, concurrencyFrom, isHeavyMime, leaseExpired, lockedByDeadLocalWorker,
  MAX_INTERRUPTIONS, needsBackfill, parseWorkerId, PermanentJobError, plainError, selectBackfill, workerId,
} from "./policy";

describe("concurrency", () => {
  it("defaults to 3 at a time, 1 heavy", () => {
    expect(concurrencyFrom({})).toEqual({ total: 3, heavy: 1 });
  });
  it("reads INGEST_CONCURRENCY and caps heavy at the total", () => {
    expect(concurrencyFrom({ INGEST_CONCURRENCY: "5", INGEST_HEAVY_CONCURRENCY: "2" })).toEqual({ total: 5, heavy: 2 });
    expect(concurrencyFrom({ INGEST_CONCURRENCY: "2", INGEST_HEAVY_CONCURRENCY: "9" })).toEqual({ total: 2, heavy: 2 });
    expect(concurrencyFrom({ INGEST_CONCURRENCY: "zero" })).toEqual({ total: 3, heavy: 1 });
    expect(concurrencyFrom({ INGEST_CONCURRENCY: "0" })).toEqual({ total: 3, heavy: 1 });
  });
  it("claims nothing when full, only light jobs when heavy slots are busy", () => {
    const cap = { total: 3, heavy: 1 };
    expect(claimFilter({ total: 0, heavy: 0 }, cap)).toBe("any");
    expect(claimFilter({ total: 1, heavy: 1 }, cap)).toBe("light");
    expect(claimFilter({ total: 2, heavy: 0 }, cap)).toBe("any");
    expect(claimFilter({ total: 3, heavy: 0 }, cap)).toBe("none");
  });
  it("counts OCR, vision, audio and PDFs as heavy", () => {
    expect(isHeavyMime("image/png")).toBe(true);
    expect(isHeavyMime("audio/mpeg")).toBe(true);
    expect(isHeavyMime("application/pdf")).toBe(true);
    expect(isHeavyMime("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe(false);
    expect(isHeavyMime("text/plain")).toBe(false);
    expect(isHeavyMime(null)).toBe(false);
  });
});

describe("retries", () => {
  const now = new Date("2026-11-04T10:00:00Z");
  it("backs off 30 s, 2 min, 8 min, capped at 30 min", () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(120_000);
    expect(backoffMs(3)).toBe(480_000);
    expect(backoffMs(10)).toBe(30 * 60_000);
  });
  it("queues again after a failure until max attempts, then fails with the reason", () => {
    const again = afterFailure({ attempts: 1, maxAttempts: 3 }, new Error("mux timed out"), now);
    expect(again.status).toBe("queued");
    if (again.status === "queued") expect(again.runAfter.getTime() - now.getTime()).toBe(30_000);
    const out = afterFailure({ attempts: 3, maxAttempts: 3 }, new Error("Failed while reading the text: bad zip"), now);
    expect(out).toEqual({ status: "failed", error: "Failed while reading the text: bad zip" });
  });
  it("does not retry what can't be fixed by trying again", () => {
    const out = afterFailure({ attempts: 1, maxAttempts: 3 }, new PermanentJobError("The file was deleted before it was read."), now);
    expect(out).toEqual({ status: "failed", error: "The file was deleted before it was read." });
  });
  it("says errors in plain words", () => {
    expect(plainError(new Error("connect ECONNREFUSED 127.0.0.1:7070"))).toMatch(/didn't answer/);
    expect(plainError(new Error('insert into "chunks" violates foreign key'))).toMatch(/database/);
    expect(plainError(null)).toBe("Something went wrong while reading it.");
    expect(plainError(new Error("x".repeat(400))).length).toBeLessThanOrEqual(300);
  });
});

describe("leases and restarts", () => {
  const now = new Date("2026-11-04T10:00:00Z");
  it("a running job whose lease has passed is lost", () => {
    expect(leaseExpired({ status: "running", leaseUntil: new Date(now.getTime() - 1) }, now)).toBe(true);
    expect(leaseExpired({ status: "running", leaseUntil: new Date(now.getTime() + 60_000) }, now)).toBe(false);
    expect(leaseExpired({ status: "running", leaseUntil: null }, now)).toBe(true);
    expect(leaseExpired({ status: "queued", leaseUntil: null }, now)).toBe(false);
  });
  it("an interrupted job goes back without using up an attempt, until it has been cut off too often", () => {
    expect(afterInterruption({ attempts: 1, interruptions: 0 })).toEqual({ status: "queued", attempts: 0, interruptions: 1 });
    const out = afterInterruption({ attempts: 1, interruptions: MAX_INTERRUPTIONS - 1 });
    expect(out.status).toBe("failed");
  });
  it("recognises a job held by a stopped server process on this machine", () => {
    const me = { host: "mac", pid: 200, boot: "b2" };
    const alive = (pid: number) => pid === 200 || pid === 300;
    expect(parseWorkerId(workerId("my.host", 42, "abc"))).toEqual({ host: "my.host", pid: 42, boot: "abc" });
    expect(lockedByDeadLocalWorker(workerId("mac", 100, "b1"), me, alive)).toBe(true); // old pid gone
    expect(lockedByDeadLocalWorker(workerId("mac", 300, "b3"), me, alive)).toBe(false); // another live process
    expect(lockedByDeadLocalWorker(workerId("mac", 200, "b1"), me, alive)).toBe(true); // same pid, earlier boot
    expect(lockedByDeadLocalWorker(workerId("mac", 200, "b2"), me, alive)).toBe(false); // that's me
    expect(lockedByDeadLocalWorker(workerId("other", 100, "b1"), me, alive)).toBe(false); // another machine: wait for the lease
    expect(lockedByDeadLocalWorker(null, me, alive)).toBe(false);
  });
});

describe("backfill", () => {
  it("queues sources left waiting or half-read without a job, once", () => {
    const rows = [
      { id: "a", status: "processing", kind: "upload", hasLiveJob: false },
      { id: "b", status: "pending", kind: "email", hasLiveJob: false },
      { id: "c", status: "pending", kind: "upload", hasLiveJob: true },
      { id: "d", status: "ready", kind: "upload", hasLiveJob: false },
      { id: "e", status: "failed", kind: "upload", hasLiveJob: false },
      { id: "f", status: "pending", kind: "chat", hasLiveJob: false },
      { id: "g", status: "pending", kind: "web", hasLiveJob: false, unread: true },
      { id: "h", status: "pending", kind: "wiki", hasLiveJob: false },
    ];
    expect(selectBackfill(rows)).toEqual(["a", "b", "h"]);
    // Running it again after the jobs exist selects nothing.
    expect(selectBackfill(rows.map((r) => ({ ...r, hasLiveJob: ["a", "b", "h"].includes(r.id) || r.hasLiveJob })))).toEqual([]);
    expect(needsBackfill({ id: "x", status: "processing", kind: "connector", hasLiveJob: false })).toBe(true);
  });
});
