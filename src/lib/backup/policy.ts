/**
 * Backup rules as pure functions (no database, no files), so they can be tested:
 * - which backups to keep (7 daily + 4 weekly),
 * - when tonight's backup is due (a local time of day in a time zone),
 * - whether the configuration allows a backup at all (BACKUP_KEY in production, S3 settings complete).
 */

export type BackupEntry = { id: string; createdAt: Date; ok: boolean };
export type Retention = { daily: number; weekly: number };
export const DEFAULT_RETENTION: Retention = { daily: 7, weekly: 4 };

/** "2026-11-04" in UTC. */
export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** ISO-8601 week, e.g. "2026-W45" (weeks start on Monday; week 1 holds the year's first Thursday). */
export function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dow);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * Which backups to keep. Of the successful ones: the newest of each of the 7 most recent days that have a backup,
 * and the newest of each of the 4 most recent ISO weeks that have one (counted from the backups that exist, not
 * from today, so a paused schedule never empties the folder). Failed or partial backups go once they are 2 days old.
 * Anything from the last hour is kept (it may still be being written).
 */
export function selectRetention(entries: BackupEntry[], now: Date, r: Retention = DEFAULT_RETENTION): { keep: string[]; remove: string[] } {
  const keep = new Set<string>();
  const ok = entries.filter((e) => e.ok).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const days = new Set<string>();
  const weeks = new Set<string>();
  for (const e of ok) {
    const d = dayKey(e.createdAt);
    if (!days.has(d) && days.size < r.daily) { days.add(d); keep.add(e.id); }
    const w = isoWeekKey(e.createdAt);
    if (!weeks.has(w) && weeks.size < r.weekly) { weeks.add(w); keep.add(e.id); }
  }
  for (const e of entries) {
    const age = now.getTime() - e.createdAt.getTime();
    if (age < 60 * 60_000) keep.add(e.id);
    else if (!e.ok && age < 2 * 86_400_000) keep.add(e.id);
  }
  const remove = entries.filter((e) => !keep.has(e.id)).map((e) => e.id);
  return { keep: entries.filter((e) => keep.has(e.id)).map((e) => e.id), remove };
}

/* ── When the nightly backup is due ──────────────────────────────────────────────────────────────────────── */

/** The wall-clock parts of `d` in `timeZone`. */
export function zonedParts(d: Date, timeZone: string): { y: number; m: number; d: number; hh: number; mm: number } {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), hh: Number(p.hour), mm: Number(p.minute) };
}

/** The instant that is local time y-m-d hh:mm in `timeZone` (DST gaps resolve forward). */
export function zonedInstant(y: number, m: number, d: number, hh: number, mm: number, timeZone: string): Date {
  const want = Date.UTC(y, m - 1, d, hh, mm);
  let t = want;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(new Date(t), timeZone);
    const got = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
    if (got === want) break;
    t += want - got;
  }
  return new Date(t);
}

/** "03:30" → { hh: 3, mm: 30 }; anything else → the default 03:00. */
export function parseTimeOfDay(s: string | undefined | null): { hh: number; mm: number } {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec((s ?? "").trim());
  return m ? { hh: Number(m[1]), mm: Number(m[2]) } : { hh: 3, mm: 0 };
}

/** The most recent scheduled moment at or before `now` (today's time, or yesterday's if today's hasn't come). */
export function lastScheduledAt(now: Date, time: { hh: number; mm: number }, timeZone: string): Date {
  const p = zonedParts(now, timeZone);
  const today = zonedInstant(p.y, p.m, p.d, time.hh, time.mm, timeZone);
  if (today.getTime() <= now.getTime()) return today;
  const y = new Date(Date.UTC(p.y, p.m - 1, p.d) - 86_400_000);
  return zonedInstant(y.getUTCFullYear(), y.getUTCMonth() + 1, y.getUTCDate(), time.hh, time.mm, timeZone);
}

/**
 * Is the scheduled backup due? Yes when nothing has been attempted since the last scheduled moment. After a failed
 * attempt it tries again an hour later, at most 3 times per scheduled moment.
 */
export function scheduledBackupDue(i: {
  now: Date; time: { hh: number; mm: number }; timeZone: string;
  lastAttemptAt: Date | null; lastOk: boolean; attemptsSinceSchedule: number;
}): boolean {
  const slot = lastScheduledAt(i.now, i.time, i.timeZone);
  if (!i.lastAttemptAt || i.lastAttemptAt.getTime() < slot.getTime()) return true;
  if (i.lastOk) return false;
  return i.attemptsSinceSchedule < 3 && i.now.getTime() - i.lastAttemptAt.getTime() >= 60 * 60_000;
}

/* ── Configuration ─────────────────────────────────────────────────────────────────────────────────────── */

export type S3Config = {
  endpoint: string; bucket: string; accessKey: string; secret: string; region: string; prefix: string; files: boolean;
};

export type BackupSettings = {
  production: boolean;
  disabled: boolean;
  /** BACKUP_KEY: unset, too short, or fine. */
  key: "missing" | "weak" | "ok";
  /** Outside production with no key: backups use a development key and say so. */
  usesDevKey: boolean;
  /** Why backups can't run (production without a usable key), or null. */
  refusal: "no_key" | "weak_key" | null;
  /** S3 when all four settings are present; `s3Missing` names what is missing when only some are. */
  s3: S3Config | null;
  s3Missing: string[];
  format: "auto" | "pg_dump" | "json";
  time: { hh: number; mm: number };
  timeZone: string;
  retention: Retention;
};

const S3_VARS = ["BACKUP_S3_ENDPOINT", "BACKUP_S3_BUCKET", "BACKUP_S3_KEY", "BACKUP_S3_SECRET"] as const;

const intIn = (raw: string | undefined, fallback: number, min: number, max: number) => {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n >= min ? Math.min(n, max) : fallback;
};

/** Read the backup settings from the environment. Never returns a secret's value to callers that show it. */
export function backupSettings(env: Record<string, string | undefined>): BackupSettings {
  const production = env.NODE_ENV === "production";
  const key = (() => {
    const s = (env.BACKUP_KEY ?? "").trim();
    if (!s) return "missing" as const;
    return s.length < 16 ? "weak" as const : "ok" as const;
  })();
  const refusal = production && key === "missing" ? "no_key" as const : key === "weak" ? "weak_key" as const : null;
  const present = S3_VARS.filter((k) => (env[k] ?? "").trim());
  const s3 = present.length === S3_VARS.length ? {
    endpoint: env.BACKUP_S3_ENDPOINT!.trim().replace(/\/+$/, ""),
    bucket: env.BACKUP_S3_BUCKET!.trim(),
    accessKey: env.BACKUP_S3_KEY!.trim(),
    secret: env.BACKUP_S3_SECRET!.trim(),
    region: (env.BACKUP_S3_REGION ?? "").trim() || "us-east-1",
    prefix: normalizePrefix(env.BACKUP_S3_PREFIX ?? "my-graph/"),
    files: env.BACKUP_S3_FILES !== "0",
  } : null;
  const fmt = env.BACKUP_FORMAT;
  let tz = (env.BACKUP_TZ ?? "").trim() || "Europe/Copenhagen";
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); } catch { tz = "Europe/Copenhagen"; }
  return {
    production, disabled: env.BACKUP_DISABLED === "1", key, usesDevKey: !production && key === "missing", refusal,
    s3, s3Missing: present.length && !s3 ? S3_VARS.filter((k) => !present.includes(k)) : [],
    format: fmt === "pg_dump" || fmt === "json" ? fmt : "auto",
    time: parseTimeOfDay(env.BACKUP_TIME), timeZone: tz,
    retention: { daily: intIn(env.BACKUP_KEEP_DAILY, 7, 1, 90), weekly: intIn(env.BACKUP_KEEP_WEEKLY, 4, 0, 52) },
  };
}

export function normalizePrefix(p: string): string {
  const s = p.trim().replace(/^\/+/, "");
  return s && !s.endsWith("/") ? `${s}/` : s;
}

/** A backup id for a moment: "20261104T020000Z-nightly". Sorts by time. */
export function backupId(at: Date, trigger: "nightly" | "manual" | "script"): string {
  return `${at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}-${trigger}`;
}

export const BACKUP_ID = /^\d{8}T\d{6}Z-(nightly|manual|script)$/;

export function parseBackupId(id: string): { at: Date; trigger: string } | null {
  if (!BACKUP_ID.test(id)) return null;
  const s = id.slice(0, 16);
  const at = new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`);
  return Number.isNaN(at.getTime()) ? null : { at, trigger: id.slice(17) };
}

/** Remove credentials from anything that might end up in an error message (URLs with passwords, keys). */
export function scrub(message: string, secrets: (string | undefined)[] = []): string {
  let m = message.replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/gi, "$1***@");
  for (const s of secrets) if (s && s.length >= 4) m = m.split(s).join("***");
  return m.slice(0, 600);
}
