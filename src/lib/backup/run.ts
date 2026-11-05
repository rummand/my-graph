/**
 * Taking a backup (server-only, script-safe: no Next imports).
 *
 * One backup is a folder under BACKUP_DIR (default: next to the uploads, /data/backups on Railway):
 *   <id>/database.sql.gz.mgbk      pg_dump, gzipped, encrypted      (or database.ndjson.gz.mgbk: the JSON format)
 *   <id>/uploads.json.gz.mgbk      every uploaded file the database refers to: storage key, sha256, size, present
 *   <id>/meta.json                 plain, no secrets: when, formats, sizes, checksums, row counts, S3 result
 * It is written as <id>.partial and renamed when complete, so a folder without ".partial" is a whole backup.
 * When S3 is configured the folder is uploaded to <prefix>backups/<id>/ (meta.json last), and uploaded files are
 * copied once each, encrypted, to <prefix>files/<storage key>.mgbk (they never change: content-addressed).
 * Retention (7 daily, 4 weekly by default) runs on both sides after a successful backup.
 * Only one backup runs at a time across every server process (a Postgres advisory lock).
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Transform, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { gzipSync } from "node:zlib";
import { sql } from "@/db";
import { pathFor, uploadDir } from "@/lib/storage";
import { DEV_KEY, encryptBuffer, encryptStream, newSalt } from "./crypto";
import { databaseUrl, jsonDumpTo, pgDumpMajor, pgDumpTo, pickFormat, serverMajor, tableCounts } from "./dump";
import { BACKUP_ID, backupId, backupSettings, parseBackupId, scrub, selectRetention, type BackupSettings } from "./policy";
import { S3Client } from "./s3";

export type Trigger = "nightly" | "manual" | "script";

export type BackupMeta = {
  format: "my-graph-backup"; version: 1; id: string; trigger: Trigger;
  createdAt: string; finishedAt: string; durationMs: number;
  database: { format: "pg_dump" | "json"; file: string; bytes: number; sha256: string; serverVersion: number; migration: string | null; tables: Record<string, number> };
  uploads: { file: string; bytes: number; sha256: string; count: number; totalBytes: number; missing: number };
  encryption: { algorithm: "AES-256-GCM"; kdf: "scrypt"; developmentKey: boolean };
  s3: { uploaded: boolean; at?: string; error?: string; filesCopied?: number; filesFailed?: number } | null;
  note: string | null;
};

export type RunResult = { id: string; trigger: Trigger; startedAt: string; finishedAt: string; ok: boolean; error: string | null; durationMs: number; s3Error: string | null };
export type BackupState = { running: { id: string; startedAt: string; pid: number } | null; last: RunResult | null; lastSuccessAt: string | null; history: RunResult[] };

export function backupDir(env: Record<string, string | undefined> = process.env): string {
  return path.resolve(env.BACKUP_DIR || path.join(path.dirname(uploadDir()), "backups"));
}

/** The key to encrypt with: BACKUP_KEY, or the development key outside production. Never logged. */
export function backupSecret(s: BackupSettings, env: Record<string, string | undefined> = process.env): string {
  const k = (env.BACKUP_KEY ?? "").trim();
  if (k) return k;
  if (s.production) throw new Error("BACKUP_KEY is not set, so backups are turned off.");
  return DEV_KEY;
}

/* ── State file ──────────────────────────────────────────────────────────────────────────────────────── */

const STATE = "state.json";

export async function readState(dir = backupDir()): Promise<BackupState> {
  try {
    const s = JSON.parse(await readFile(path.join(dir, STATE), "utf8")) as BackupState;
    return { running: s.running ?? null, last: s.last ?? null, lastSuccessAt: s.lastSuccessAt ?? null, history: Array.isArray(s.history) ? s.history : [] };
  } catch {
    return { running: null, last: null, lastSuccessAt: null, history: [] };
  }
}

async function writeState(dir: string, patch: (s: BackupState) => BackupState): Promise<void> {
  await mkdir(dir, { recursive: true });
  const next = patch(await readState(dir));
  const tmp = path.join(dir, `.${STATE}.${process.pid}.tmp`);
  await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  await rename(tmp, path.join(dir, STATE));
}

/* ── Listing ─────────────────────────────────────────────────────────────────────────────────────────── */

export type BackupListing = { id: string; createdAt: Date; trigger: string; ok: boolean; meta: BackupMeta | null; bytes: number };

export async function listBackups(dir = backupDir()): Promise<BackupListing[]> {
  let names: string[];
  try { names = await readdir(dir); } catch { return []; }
  const out: BackupListing[] = [];
  for (const n of names) {
    const base = n.endsWith(".partial") ? n.slice(0, -".partial".length) : n;
    const parsed = parseBackupId(base);
    if (!parsed) continue;
    let meta: BackupMeta | null = null;
    if (!n.endsWith(".partial")) {
      try { meta = JSON.parse(await readFile(path.join(dir, n, "meta.json"), "utf8")) as BackupMeta; } catch { meta = null; }
    }
    out.push({
      id: n, createdAt: parsed.at, trigger: parsed.trigger, ok: !!meta, meta,
      bytes: meta ? meta.database.bytes + meta.uploads.bytes : 0,
    });
  }
  return out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/* ── Taking one ──────────────────────────────────────────────────────────────────────────────────────── */

/** A pass-through that hashes and counts what goes by. */
function tap(): { stream: Transform; result: () => { sha256: string; bytes: number } } {
  const h = createHash("sha256");
  let bytes = 0;
  const stream = new Transform({ transform(c: Buffer, _e, cb) { h.update(c); bytes += c.length; cb(null, c); } });
  return { stream, result: () => ({ sha256: h.digest("hex"), bytes }) };
}

const LOCK_KEY = 736_200_117; // pg_advisory_lock key for "a backup is running"

export class BackupBusy extends Error {
  constructor() { super("A backup is already running."); this.name = "BackupBusy"; }
}

/**
 * Take a backup now. Throws BackupBusy when another one is running (in any process); records every outcome in
 * state.json. Returns the result (ok or the reason it failed).
 */
export async function runBackup(trigger: Trigger, env: Record<string, string | undefined> = process.env): Promise<RunResult> {
  const settings = backupSettings(env);
  const dir = backupDir(env);
  const started = new Date();
  const id = backupId(started, trigger);

  if (settings.refusal) {
    const error = settings.refusal === "no_key"
      ? "BACKUP_KEY is not set. Backups are refused in production without an encryption key."
      : "BACKUP_KEY is shorter than 16 characters. Use a long random key (openssl rand -base64 32).";
    const r: RunResult = { id, trigger, startedAt: started.toISOString(), finishedAt: started.toISOString(), ok: false, error, durationMs: 0, s3Error: null };
    await writeState(dir, (s) => ({ ...s, last: r, history: [r, ...s.history].slice(0, 30) })).catch(() => {});
    return r;
  }

  const reserved = await sql.reserve();
  try {
    const [{ locked }] = await reserved<{ locked: boolean }[]>`select pg_try_advisory_lock(${LOCK_KEY}) as locked`;
    if (!locked) throw new BackupBusy();
    try {
      await writeState(dir, (s) => ({ ...s, running: { id, startedAt: started.toISOString(), pid: process.pid } }));
      let result: RunResult;
      try {
        const meta = await takeBackup(id, trigger, started, settings, dir, env);
        result = {
          id, trigger, startedAt: started.toISOString(), finishedAt: meta.finishedAt, ok: true, error: null,
          durationMs: meta.durationMs, s3Error: meta.s3?.error ?? null,
        };
      } catch (e) {
        const error = scrub(e instanceof Error ? e.message : String(e), [env.BACKUP_KEY, env.BACKUP_S3_SECRET, env.BACKUP_S3_KEY]);
        console.error("[backup] failed:", error);
        const fin = new Date();
        result = { id, trigger, startedAt: started.toISOString(), finishedAt: fin.toISOString(), ok: false, error, durationMs: fin.getTime() - started.getTime(), s3Error: null };
      }
      await writeState(dir, (s) => ({
        running: null, last: result, lastSuccessAt: result.ok ? result.finishedAt : s.lastSuccessAt, history: [result, ...s.history].slice(0, 30),
      }));
      return result;
    } finally {
      await reserved`select pg_advisory_unlock(${LOCK_KEY})`.catch(() => {});
    }
  } finally {
    reserved.release();
  }
}

/** Is a backup running anywhere right now? (The advisory lock is held.) */
export async function backupRunning(): Promise<boolean> {
  const [r] = await sql<{ n: number }[]>`select count(*)::int as n from pg_locks where locktype = 'advisory' and objid = ${LOCK_KEY} and granted`;
  return (r?.n ?? 0) > 0;
}

async function takeBackup(id: string, trigger: Trigger, started: Date, settings: BackupSettings, dir: string, env: Record<string, string | undefined>): Promise<BackupMeta> {
  const secret = backupSecret(settings, env);
  const salt = newSalt();
  const partial = path.join(dir, `${id}.partial`);
  await mkdir(partial, { recursive: true, mode: 0o700 });

  try {
    // 1. The database.
    const server = await serverMajor(sql);
    const { format, note } = pickFormat(settings.format, await pgDumpMajor(), server);
    const dbFile = format === "pg_dump" ? "database.sql.gz.mgbk" : "database.ndjson.gz.mgbk";
    const t = tap();
    const sink: Writable[] = [encryptStream(secret, salt), t.stream, createWriteStream(path.join(partial, dbFile), { mode: 0o600 })];
    let tables: Record<string, number>;
    if (format === "pg_dump") {
      // Counts first (a moment earlier than the dump; they're for reading, not for checking row by row).
      tables = await tableCounts(sql);
      await pgDumpTo(databaseUrl(env), sink);
    } else {
      tables = await jsonDumpTo(sql, sink);
    }
    const dbOut = t.result();
    let migration: string | null = null;
    try {
      const [m] = await sql<{ hash: string }[]>`select hash from drizzle.__drizzle_migrations order by created_at desc limit 1`;
      migration = m?.hash ?? null;
    } catch { migration = null; }

    // 2. The uploads the database refers to.
    const files = await sql<{ storage_key: string; sha256: string | null; size: number | null }[]>`
      select distinct on (storage_key) storage_key, sha256, size from sources where storage_key is not null order by storage_key`;
    const manifest: { key: string; sha256: string | null; size: number | null; present: boolean }[] = [];
    let totalBytes = 0;
    let missing = 0;
    for (const f of files) {
      let present = false;
      try { const s = await stat(pathFor(f.storage_key)); present = s.isFile(); totalBytes += s.size; } catch { present = false; }
      if (!present) missing++;
      manifest.push({ key: f.storage_key, sha256: f.sha256, size: f.size, present });
    }
    const upPlain = gzipSync(Buffer.from(JSON.stringify({ uploadDir: "UPLOAD_DIR", files: manifest })));
    const upEnc = encryptBuffer(upPlain, secret, salt);
    await writeFile(path.join(partial, "uploads.json.gz.mgbk"), upEnc, { mode: 0o600 });

    const finished = new Date();
    const meta: BackupMeta = {
      format: "my-graph-backup", version: 1, id, trigger, createdAt: started.toISOString(), finishedAt: finished.toISOString(),
      durationMs: finished.getTime() - started.getTime(),
      database: { format, file: dbFile, bytes: dbOut.bytes, sha256: dbOut.sha256, serverVersion: server, migration, tables },
      uploads: { file: "uploads.json.gz.mgbk", bytes: upEnc.length, sha256: createHash("sha256").update(upEnc).digest("hex"), count: manifest.length, totalBytes, missing },
      encryption: { algorithm: "AES-256-GCM", kdf: "scrypt", developmentKey: settings.usesDevKey },
      s3: null, note,
    };
    await writeFile(path.join(partial, "meta.json"), JSON.stringify(meta, null, 2), { mode: 0o600 });
    const final = path.join(dir, id);
    await rename(partial, final);

    // 3. Off-site copy (a failure here is reported but doesn't undo the local backup).
    if (settings.s3) {
      try {
        const s3 = new S3Client(settings.s3);
        const base = `${settings.s3.prefix}backups/${id}/`;
        await s3.putFile(`${base}${dbFile}`, path.join(final, dbFile));
        await s3.putFile(`${base}uploads.json.gz.mgbk`, path.join(final, "uploads.json.gz.mgbk"));
        let filesCopied = 0;
        let filesFailed = 0;
        if (settings.s3.files) ({ copied: filesCopied, failed: filesFailed } = await syncFiles(s3, settings.s3.prefix, manifest, secret, salt, dir));
        meta.s3 = { uploaded: true, at: new Date().toISOString(), filesCopied, filesFailed };
        await writeFile(path.join(final, "meta.json"), JSON.stringify(meta, null, 2), { mode: 0o600 });
        await s3.putBuffer(`${base}meta.json`, Buffer.from(JSON.stringify(meta, null, 2)), "application/json");
        await applyRemoteRetention(s3, settings, new Date());
      } catch (e) {
        meta.s3 = { uploaded: false, error: scrub(e instanceof Error ? e.message : String(e), [settings.s3.secret, settings.s3.accessKey, secret]) };
        await writeFile(path.join(final, "meta.json"), JSON.stringify(meta, null, 2), { mode: 0o600 });
      }
    }

    await applyLocalRetention(dir, settings, new Date());
    return meta;
  } catch (e) {
    await rm(partial, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

/* ── Uploaded files to S3 (once each) ─────────────────────────────────────────────────────────────────── */

const SYNCED = ".s3-files.json";

async function syncFiles(
  s3: S3Client, prefix: string, manifest: { key: string; present: boolean }[], secret: string, salt: Buffer, dir: string,
): Promise<{ copied: number; failed: number }> {
  let done = new Set<string>();
  try {
    done = new Set(JSON.parse(await readFile(path.join(dir, SYNCED), "utf8")) as string[]);
  } catch {
    // No index yet (first run, or a new volume): ask the bucket what is already there.
    const there = await s3.list(`${prefix}files/`);
    done = new Set(there.map((o) => o.key.slice(`${prefix}files/`.length).replace(/\.mgbk$/, "")));
  }
  let copied = 0;
  let failed = 0;
  const tmp = path.join(dir, `.upload-${process.pid}.tmp`);
  try {
    for (const f of manifest) {
      if (!f.present || done.has(f.key)) continue;
      try {
        await pipeline(createReadStream(pathFor(f.key)), encryptStream(secret, salt), createWriteStream(tmp, { mode: 0o600 }));
        await s3.putFile(`${prefix}files/${f.key}.mgbk`, tmp);
        done.add(f.key);
        copied++;
      } catch (e) {
        failed++;
        if (failed <= 3) console.warn("[backup] copying an upload to S3 failed:", e instanceof Error ? e.message : e);
      }
    }
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
    await writeFile(path.join(dir, SYNCED), JSON.stringify([...done]), { mode: 0o600 }).catch(() => {});
  }
  return { copied, failed };
}

/* ── Retention ───────────────────────────────────────────────────────────────────────────────────────── */

export async function applyLocalRetention(dir: string, settings: BackupSettings, now: Date): Promise<string[]> {
  const list = await listBackups(dir);
  const { remove } = selectRetention(list.map((b) => ({ id: b.id, createdAt: b.createdAt, ok: b.ok })), now, settings.retention);
  for (const id of remove) {
    if (!BACKUP_ID.test(id.replace(/\.partial$/, ""))) continue; // never touch anything else in the folder
    await rm(path.join(dir, id), { recursive: true, force: true });
  }
  return remove;
}

export async function applyRemoteRetention(s3: S3Client, settings: BackupSettings, now: Date): Promise<string[]> {
  if (!settings.s3) return [];
  const base = `${settings.s3.prefix}backups/`;
  const objects = await s3.list(base);
  const byId = new Map<string, { keys: string[]; ok: boolean }>();
  for (const o of objects) {
    const id = o.key.slice(base.length).split("/")[0];
    if (!BACKUP_ID.test(id)) continue;
    const e = byId.get(id) ?? { keys: [], ok: false };
    e.keys.push(o.key);
    if (o.key.endsWith("/meta.json")) e.ok = true;
    byId.set(id, e);
  }
  const entries = [...byId.entries()].map(([id, e]) => ({ id, createdAt: parseBackupId(id)!.at, ok: e.ok }));
  const { remove } = selectRetention(entries, now, settings.retention);
  for (const id of remove) for (const k of byId.get(id)!.keys) await s3.delete(k);
  return remove;
}
