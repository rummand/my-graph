/**
 * Restoring a backup into a database (used by scripts/restore.ts; no Next imports, never run by the app itself).
 * Order: read meta.json → check the file checksum → decrypt the whole file once to prove the key and the bytes
 * (nothing is loaded before that passes) → load it → compare row counts → check (and optionally fetch) the uploads.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { gunzipSync } from "node:zlib";
import postgres from "postgres";
import { DEV_KEY, decryptBuffer, decryptFileStream, verifyFile } from "./crypto";
import { jsonRestore, psqlRestore, tableCounts } from "./dump";
import type { BackupMeta } from "./run";
import { S3Client } from "./s3";
import type { S3Config } from "./policy";

export type RestoreOptions = {
  /** The backup folder (containing meta.json). */
  folder: string;
  targetUrl: string;
  /** BACKUP_KEY used when the backup was taken. */
  secret: string | null;
  /** Allowed only outside production: use the development key when the backup says it was taken with it. */
  allowDevKey: boolean;
  /** Drop everything in the target database first (otherwise it must be empty). */
  wipe: boolean;
  /** Apply the app's migrations to the target (needed before a JSON restore). */
  migrate: (url: string) => Promise<void>;
  uploadDir: string;
  /** Download uploads the target is missing from S3 (when the backup copied them there). */
  fetchFiles: S3Config | null;
  log: (s: string) => void;
};

export type RestoreReport = {
  id: string; format: string; tables: number; rows: number;
  countMismatches: { table: string; expected: number; actual: number }[];
  uploads: { listed: number; present: number; missing: number; fetched: number; failed: number };
};

async function sha256File(p: string): Promise<string> {
  const h = createHash("sha256");
  await pipeline(createReadStream(p), async function* (src) { for await (const c of src) h.update(c as Buffer); });
  return h.digest("hex");
}

export async function readMeta(folder: string): Promise<BackupMeta> {
  const meta = JSON.parse(await readFile(path.join(folder, "meta.json"), "utf8")) as BackupMeta;
  if (meta.format !== "my-graph-backup" || meta.version !== 1) throw new Error("This folder doesn't hold a My Graph backup (meta.json is missing or unknown).");
  return meta;
}

export function secretFor(meta: BackupMeta, secret: string | null, allowDevKey: boolean): string {
  if (meta.encryption.developmentKey) {
    if (!allowDevKey) throw new Error("This backup was taken with the development key; restore it outside production.");
    return DEV_KEY;
  }
  if (!secret) throw new Error("Set BACKUP_KEY to the key the backup was taken with.");
  return secret;
}

async function userTableCount(sql: postgres.Sql): Promise<number> {
  const [r] = await sql<{ n: number }[]>`select count(*)::int as n from information_schema.tables where table_schema in ('public', 'drizzle') and table_type = 'BASE TABLE'`;
  return r.n;
}

export async function restoreBackup(o: RestoreOptions): Promise<RestoreReport> {
  const meta = await readMeta(o.folder);
  const secret = secretFor(meta, o.secret, o.allowDevKey);
  const dbPath = path.join(o.folder, meta.database.file);

  o.log(`Checking ${meta.database.file} (${(meta.database.bytes / 1024 / 1024).toFixed(1)} MB)…`);
  const sum = await sha256File(dbPath);
  if (sum !== meta.database.sha256) throw new Error("The database file's checksum doesn't match meta.json: the file is damaged or incomplete.");
  await verifyFile(dbPath, secret);
  o.log("The key is right and the file is intact.");

  const sql = postgres(o.targetUrl, { max: 2, onnotice: () => {} });
  try {
    if (o.wipe) {
      o.log("Emptying the target database…");
      await sql.unsafe(`drop schema if exists drizzle cascade; drop schema if exists public cascade; create schema public;`);
    } else if ((await userTableCount(sql)) > 0 && meta.database.format === "pg_dump") {
      throw new Error("The target database isn't empty. Restore into a new database, or pass --wipe to empty this one first.");
    }

    let counts: Record<string, number>;
    if (meta.database.format === "pg_dump") {
      o.log("Loading the SQL dump with psql (one transaction)…");
      await psqlRestore(o.targetUrl, await decryptFileStream(dbPath, secret));
      counts = await tableCounts(sql);
    } else {
      o.log("Applying migrations to the target…");
      await o.migrate(o.targetUrl);
      o.log("Loading tables…");
      counts = await jsonRestore(sql, await decryptFileStream(dbPath, secret), o.log);
    }

    const countMismatches = Object.entries(meta.database.tables)
      .map(([table, expected]) => ({ table, expected, actual: counts[table] ?? 0 }))
      .filter((c) => c.expected !== c.actual);

    // Uploads.
    const manifest = JSON.parse(gunzipSync(decryptBuffer(await readFile(path.join(o.folder, meta.uploads.file)), secret)).toString("utf8")) as {
      files: { key: string; sha256: string | null; size: number | null }[];
    };
    const up = { listed: manifest.files.length, present: 0, missing: 0, fetched: 0, failed: 0 };
    const s3 = o.fetchFiles ? new S3Client(o.fetchFiles) : null;
    for (const f of manifest.files) {
      if (!/^[0-9a-f]{2}\/[0-9a-f]{64}$/.test(f.key)) continue;
      const full = path.join(o.uploadDir, f.key);
      let here = false;
      try { here = (await stat(full)).isFile(); } catch { here = false; }
      if (here) { up.present++; continue; }
      if (!s3 || !o.fetchFiles) { up.missing++; continue; }
      try {
        await fetchFile(s3, o.fetchFiles.prefix, f.key, full, secret, f.sha256);
        up.fetched++;
      } catch (e) {
        up.failed++;
        up.missing++;
        o.log(`Couldn't fetch ${f.key}: ${e instanceof Error ? e.message : e}`);
      }
    }
    const rows = Object.values(counts).reduce((a, b) => a + b, 0);
    return { id: meta.id, format: meta.database.format, tables: Object.keys(counts).length, rows, countMismatches, uploads: up };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function fetchFile(s3: S3Client, prefix: string, key: string, dest: string, secret: string, expectedSha: string | null): Promise<void> {
  const res = await s3.get(`${prefix}files/${key}.mgbk`);
  await mkdir(path.dirname(dest), { recursive: true });
  const enc = `${dest}.download`;
  const tmp = `${dest}.tmp`;
  try {
    await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(enc, { mode: 0o600 }));
    await verifyFile(enc, secret);
    await pipeline(await decryptFileStream(enc, secret), createWriteStream(tmp, { mode: 0o640 }));
    if (expectedSha && (await sha256File(tmp)) !== expectedSha) throw new Error("checksum mismatch after download");
    await rename(tmp, dest);
  } finally {
    await rm(enc, { force: true }).catch(() => {});
    await rm(tmp, { force: true }).catch(() => {});
  }
}

/** Download a whole backup folder from S3 into `into/<id>` (for restoring on a machine without the volume). */
export async function downloadBackup(s3c: S3Config, id: string, into: string): Promise<string> {
  const s3 = new S3Client(s3c);
  const base = `${s3c.prefix}backups/${id}/`;
  const objects = await s3.list(base);
  if (!objects.some((o) => o.key.endsWith("/meta.json"))) throw new Error(`No complete backup ${id} in the bucket.`);
  const folder = path.join(into, id);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  for (const o of objects) {
    const name = o.key.slice(base.length);
    if (!/^[a-z0-9.]+$/i.test(name)) continue;
    const res = await s3.get(o.key);
    await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(path.join(folder, name), { mode: 0o600 }));
  }
  return folder;
}
