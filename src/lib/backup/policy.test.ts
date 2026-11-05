import { describe, expect, it } from "vitest";
import {
  backupId, backupSettings, isoWeekKey, lastScheduledAt, parseBackupId, parseTimeOfDay, scheduledBackupDue, scrub, selectRetention,
  zonedInstant, type BackupEntry,
} from "./policy";

const at = (s: string) => new Date(s);
const entry = (iso: string, ok = true): BackupEntry => ({ id: iso, createdAt: at(iso), ok });

describe("retention: 7 daily, 4 weekly", () => {
  it("keeps the newest backup of each of the last 7 days", () => {
    // Two backups a day (nightly + a manual one) for 10 days.
    const list: BackupEntry[] = [];
    for (let d = 1; d <= 10; d++) {
      const day = String(d).padStart(2, "0");
      list.push(entry(`2026-11-${day}T02:00:00Z`), entry(`2026-11-${day}T15:00:00Z`));
    }
    const { keep, remove } = selectRetention(list, at("2026-11-10T16:30:00Z"), { daily: 7, weekly: 0 });
    expect(keep.sort()).toEqual(["04", "05", "06", "07", "08", "09", "10"].map((d) => `2026-11-${d}T15:00:00Z`));
    expect(remove).toHaveLength(13);
  });

  it("also keeps the newest of each of the last 4 ISO weeks", () => {
    const list: BackupEntry[] = [];
    for (let i = 0; i < 60; i++) list.push(entry(new Date(Date.UTC(2026, 8, 1, 2) + i * 86_400_000).toISOString()));
    const now = at("2026-10-30T12:00:00Z");
    const { keep } = selectRetention(list, now);
    const kept = keep.map((k) => new Date(k));
    // 7 daily: Oct 24 … Oct 30.
    for (let d = 24; d <= 30; d++) expect(keep).toContain(`2026-10-${d}T02:00:00.000Z`);
    // Weekly: the Sundays ending the three weeks before this one (this week's newest is Oct 30, already a daily).
    expect(keep).toContain("2026-10-25T02:00:00.000Z"); // week 43 (also daily)
    expect(keep).toContain("2026-10-18T02:00:00.000Z"); // week 42
    expect(keep).toContain("2026-10-11T02:00:00.000Z"); // week 41
    expect(keep).not.toContain("2026-10-04T02:00:00.000Z"); // week 40: a fifth week
    expect(kept).toHaveLength(9);
  });

  it("counts from the backups that exist, so a stopped schedule never deletes everything", () => {
    const old = [entry("2026-01-01T02:00:00Z"), entry("2026-01-02T02:00:00Z")];
    expect(selectRetention(old, at("2026-11-01T00:00:00Z")).remove).toEqual([]);
  });

  it("drops failed backups after 2 days and never touches the last hour", () => {
    const now = at("2026-11-10T12:00:00Z");
    const list = [
      entry("2026-11-10T11:30:00Z", false), // in progress or just failed: kept
      entry("2026-11-09T02:00:00Z", false), // failed yesterday: kept for diagnosis
      entry("2026-11-07T02:00:00Z", false), // failed 3 days ago: removed
      entry("2026-11-10T02:00:00Z"),
    ];
    const { keep, remove } = selectRetention(list, now);
    expect(remove).toEqual(["2026-11-07T02:00:00Z"]);
    expect(keep).toHaveLength(3);
  });
});

describe("ISO weeks", () => {
  it("follows ISO-8601 at year boundaries", () => {
    expect(isoWeekKey(at("2026-01-01T12:00:00Z"))).toBe("2026-W01"); // Thursday
    expect(isoWeekKey(at("2027-01-01T12:00:00Z"))).toBe("2026-W53"); // Friday, still 2026's last week
    expect(isoWeekKey(at("2026-11-04T12:00:00Z"))).toBe("2026-W45");
    expect(isoWeekKey(at("2026-11-08T23:00:00Z"))).toBe("2026-W45"); // Sunday
    expect(isoWeekKey(at("2026-11-09T00:00:00Z"))).toBe("2026-W46"); // Monday
  });
});

describe("when the nightly backup is due", () => {
  const tz = "Europe/Copenhagen";
  it("converts local time to the right instant, summer and winter", () => {
    expect(zonedInstant(2026, 7, 1, 3, 0, tz).toISOString()).toBe("2026-07-01T01:00:00.000Z");
    expect(zonedInstant(2026, 12, 1, 3, 0, tz).toISOString()).toBe("2026-12-01T02:00:00.000Z");
  });

  it("finds the most recent 03:00", () => {
    expect(lastScheduledAt(at("2026-11-04T10:00:00Z"), { hh: 3, mm: 0 }, tz).toISOString()).toBe("2026-11-04T02:00:00.000Z");
    expect(lastScheduledAt(at("2026-11-04T01:00:00Z"), { hh: 3, mm: 0 }, tz).toISOString()).toBe("2026-11-03T02:00:00.000Z");
  });

  it("is due once per night, and retries a failure an hour later, at most 3 times", () => {
    const base = { time: { hh: 3, mm: 0 }, timeZone: tz };
    const now = at("2026-11-04T02:10:00Z");
    expect(scheduledBackupDue({ ...base, now, lastAttemptAt: null, lastOk: false, attemptsSinceSchedule: 0 })).toBe(true);
    expect(scheduledBackupDue({ ...base, now, lastAttemptAt: at("2026-11-03T02:00:00Z"), lastOk: true, attemptsSinceSchedule: 0 })).toBe(true);
    expect(scheduledBackupDue({ ...base, now, lastAttemptAt: at("2026-11-04T02:01:00Z"), lastOk: true, attemptsSinceSchedule: 1 })).toBe(false);
    expect(scheduledBackupDue({ ...base, now, lastAttemptAt: at("2026-11-04T02:01:00Z"), lastOk: false, attemptsSinceSchedule: 1 })).toBe(false);
    const later = at("2026-11-04T03:05:00Z");
    expect(scheduledBackupDue({ ...base, now: later, lastAttemptAt: at("2026-11-04T02:01:00Z"), lastOk: false, attemptsSinceSchedule: 1 })).toBe(true);
    expect(scheduledBackupDue({ ...base, now: later, lastAttemptAt: at("2026-11-04T02:01:00Z"), lastOk: false, attemptsSinceSchedule: 3 })).toBe(false);
  });

  it("reads BACKUP_TIME, falling back to 03:00", () => {
    expect(parseTimeOfDay("01:45")).toEqual({ hh: 1, mm: 45 });
    expect(parseTimeOfDay("25:00")).toEqual({ hh: 3, mm: 0 });
    expect(parseTimeOfDay(undefined)).toEqual({ hh: 3, mm: 0 });
  });
});

describe("settings", () => {
  it("refuses in production without BACKUP_KEY, and uses the development key elsewhere", () => {
    expect(backupSettings({ NODE_ENV: "production" }).refusal).toBe("no_key");
    expect(backupSettings({ NODE_ENV: "production", BACKUP_KEY: "x".repeat(32) }).refusal).toBeNull();
    expect(backupSettings({ NODE_ENV: "production", BACKUP_KEY: "short" }).refusal).toBe("weak_key");
    const dev = backupSettings({ NODE_ENV: "development" });
    expect(dev.refusal).toBeNull();
    expect(dev.usesDevKey).toBe(true);
  });

  it("turns S3 on only with all four settings, and names what is missing", () => {
    const all = { BACKUP_S3_ENDPOINT: "https://s3.example.com/", BACKUP_S3_BUCKET: "b", BACKUP_S3_KEY: "k", BACKUP_S3_SECRET: "s" };
    const s = backupSettings(all);
    expect(s.s3).toMatchObject({ endpoint: "https://s3.example.com", bucket: "b", region: "us-east-1", prefix: "my-graph/", files: true });
    const partial = backupSettings({ BACKUP_S3_ENDPOINT: "https://x", BACKUP_S3_BUCKET: "b" });
    expect(partial.s3).toBeNull();
    expect(partial.s3Missing).toEqual(["BACKUP_S3_KEY", "BACKUP_S3_SECRET"]);
    expect(backupSettings({}).s3Missing).toEqual([]);
  });
});

describe("ids and messages", () => {
  it("makes sortable ids and reads them back", () => {
    const id = backupId(at("2026-11-04T02:00:05.123Z"), "nightly");
    expect(id).toBe("20261104T020005Z-nightly");
    expect(parseBackupId(id)?.at.toISOString()).toBe("2026-11-04T02:00:05.000Z");
    expect(parseBackupId("../etc")).toBeNull();
  });

  it("never lets a password or key into an error message", () => {
    const m = scrub("connect to postgres://app:hunter2@db:5432/x failed; key=abcdefgh", ["abcdefgh"]);
    expect(m).not.toContain("hunter2");
    expect(m).not.toContain("abcdefgh");
  });
});
