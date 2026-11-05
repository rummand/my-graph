/**
 * Getting the database out (and back in). Server-only and script-safe (no Next imports).
 *
 * Two formats, picked by BACKUP_FORMAT (default "auto": pg_dump when a new-enough one is installed, else JSON):
 *  - "pg_dump": plain SQL from `pg_dump --no-owner --no-privileges`; restored with `psql` into an empty database.
 *  - "json": every table in the `public` and `drizzle` schemas, row by row as NDJSON (`row_to_json`), streamed with a
 *    cursor. Restored into a database that has the same migrations applied (scripts/restore.ts does that first).
 * Both are gzipped, then encrypted (./crypto). The database password is passed to child processes in PGPASSWORD,
 * never on the command line.
 */
import { spawn } from "node:child_process";
import { createGzip, createGunzip } from "node:zlib";
import { Readable, Transform, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import postgres from "postgres";

export const DEFAULT_DATABASE_URL = "postgres://mygraph:mygraph@localhost:5433/mygraph";

/** stream.pipeline over a list (the typings only take fixed arities). */
export const pipeAll = pipeline as unknown as (streams: (NodeJS.ReadableStream | NodeJS.WritableStream | NodeJS.ReadWriteStream)[]) => Promise<void>;

export function databaseUrl(env: Record<string, string | undefined> = process.env): string {
  return env.DATABASE_URL || DEFAULT_DATABASE_URL;
}

/** libpq environment for a database URL (so no secret is on a command line). */
export function pgEnv(url: string): Record<string, string> {
  const u = new URL(url);
  const env: Record<string, string> = {
    PGHOST: decodeURIComponent(u.hostname), PGPORT: u.port || "5432",
    PGUSER: decodeURIComponent(u.username), PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, "")),
  };
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  const ssl = u.searchParams.get("sslmode");
  if (ssl) env.PGSSLMODE = ssl;
  return env;
}

function childEnv(url: string): NodeJS.ProcessEnv {
  // Only what the client tools need; the app's own secrets aren't handed to child processes.
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", LANG: "C.UTF-8", ...pgEnv(url) } as unknown as NodeJS.ProcessEnv;
}

/** The installed pg_dump's major version, or null when there is none. */
export async function pgDumpMajor(bin = process.env.PG_DUMP_PATH || "pg_dump"): Promise<number | null> {
  return new Promise((resolve) => {
    let out = "";
    let p;
    try { p = spawn(bin, ["--version"], { stdio: ["ignore", "pipe", "ignore"] }); } catch { resolve(null); return; }
    p.stdout.on("data", (d) => { out += String(d); });
    p.on("error", () => resolve(null));
    p.on("close", (code) => {
      const m = /(\d+)(?:\.\d+)?/.exec(out);
      resolve(code === 0 && m ? Number(m[1]) : null);
    });
  });
}

export async function serverMajor(sql: postgres.Sql): Promise<number> {
  const [r] = await sql<{ v: string }[]>`select current_setting('server_version_num') as v`;
  return Math.floor(Number(r.v) / 10000);
}

/** Which format to write: pg_dump needs a client at least as new as the server. */
export function pickFormat(wanted: "auto" | "pg_dump" | "json", dumpMajor: number | null, server: number): { format: "pg_dump" | "json"; note: string | null } {
  const usable = dumpMajor !== null && dumpMajor >= server;
  if (wanted === "json") return { format: "json", note: null };
  if (usable) return { format: "pg_dump", note: null };
  const why = dumpMajor === null ? "pg_dump isn't installed" : `pg_dump ${dumpMajor} is older than the database (${server})`;
  if (wanted === "pg_dump") throw new Error(`BACKUP_FORMAT is pg_dump, but ${why}.`);
  return { format: "json", note: `${why}, so the database was saved table by table (JSON).` };
}

/** Run pg_dump into `sink` (gzip + encrypt + file, set up by the caller). */
export async function pgDumpTo(url: string, sink: Writable[]): Promise<void> {
  const bin = process.env.PG_DUMP_PATH || "pg_dump";
  const p = spawn(bin, ["--format=plain", "--no-owner", "--no-privileges", "--quote-all-identifiers", "--encoding=UTF8"], {
    env: childEnv(url), stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  p.stderr.on("data", (d) => { if (err.length < 4000) err += String(d); });
  const exited = new Promise<number>((resolve, reject) => { p.on("error", reject); p.on("close", (c) => resolve(c ?? 1)); });
  await pipeAll([p.stdout, createGzip({ level: 6 }), ...sink]);
  const code = await exited;
  if (code !== 0) throw new Error(`pg_dump stopped with code ${code}: ${err.trim().split("\n").slice(-3).join(" ")}`);
}

export type TableInfo = { schema: string; name: string; columns: string[] };

export async function listTables(sql: postgres.Sql): Promise<TableInfo[]> {
  const rows = await sql<{ s: string; t: string; c: string[] }[]>`
    select c.table_schema as s, c.table_name as t, array_agg(c.column_name::text order by c.ordinal_position) as c
    from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
    where t.table_type = 'BASE TABLE' and c.table_schema in ('public', 'drizzle')
    group by c.table_schema, c.table_name
    order by c.table_schema, c.table_name`;
  return rows.map((r) => ({ schema: r.s, name: r.t, columns: r.c }));
}

const q = (s: string) => `"${s.replace(/"/g, '""')}"`;

/**
 * Write every table as NDJSON into `sink` (gzip + encrypt + file): a `{"$table":…}` line, then one line per row,
 * and a final `{"$end":…}` line so a cut-off file is recognised. Returns rows per table.
 */
export async function jsonDumpTo(sql: postgres.Sql, sink: Writable[]): Promise<Record<string, number>> {
  const tables = await listTables(sql);
  const counts: Record<string, number> = {};
  async function* lines(): AsyncGenerator<string> {
    yield `${JSON.stringify({ $format: "my-graph-json-dump", version: 1, at: new Date().toISOString() })}\n`;
    let total = 0;
    for (const t of tables) {
      yield `${JSON.stringify({ $table: t })}\n`;
      let n = 0;
      const cursor = sql.unsafe<{ j: string }[]>(`select row_to_json(x)::text as j from ${q(t.schema)}.${q(t.name)} x`).cursor(500);
      for await (const batch of cursor) {
        let buf = "";
        for (const r of batch) { buf += `${r.j}\n`; n++; }
        yield buf;
      }
      counts[`${t.schema}.${t.name}`] = n;
      total += n;
    }
    yield `${JSON.stringify({ $end: { tables: tables.length, rows: total } })}\n`;
  }
  await pipeAll([Readable.from(lines()), createGzip({ level: 6 }), ...sink]);
  return counts;
}

/** Rows per table (estimates are not good enough for a manifest: exact counts). */
export async function tableCounts(sql: postgres.Sql): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of await listTables(sql)) {
    const [r] = await sql.unsafe<{ n: string }[]>(`select count(*)::text as n from ${q(t.schema)}.${q(t.name)}`);
    out[`${t.schema}.${t.name}`] = Number(r.n);
  }
  return out;
}

/* ── Restore ───────────────────────────────────────────────────────────────────────────────────────────── */

/** pg_dump 17 writes settings an older server doesn't know; drop them so a newer client's dump loads into 16. */
export function filterDumpLine(line: string): string | null {
  if (/^SET transaction_timeout\b/.test(line)) return null;
  return line;
}

/** Feed a plain SQL dump (gzipped plaintext stream) into psql, in one transaction, stopping at the first error. */
export async function psqlRestore(url: string, gz: Readable): Promise<void> {
  const bin = process.env.PSQL_PATH || "psql";
  const p = spawn(bin, ["-X", "-q", "-v", "ON_ERROR_STOP=1", "--single-transaction", "-f", "-"], {
    env: childEnv(url), stdio: ["pipe", "ignore", "pipe"],
  });
  let err = "";
  p.stderr.on("data", (d) => { if (err.length < 8000) err += String(d); });
  const exited = new Promise<number>((resolve, reject) => { p.on("error", reject); p.on("close", (c) => resolve(c ?? 1)); });
  let rest = "";
  const filter = new Transform({
    transform(chunk: Buffer, _e, cb) {
      const text = rest + chunk.toString("utf8");
      const parts = text.split("\n");
      rest = parts.pop() ?? "";
      cb(null, parts.map(filterDumpLine).filter((l): l is string => l !== null).map((l) => `${l}\n`).join(""));
    },
    flush(cb) { const l = filterDumpLine(rest); cb(null, l ?? ""); },
  });
  await pipeline(gz, createGunzip(), filter, p.stdin).catch((e) => { if ((e as NodeJS.ErrnoException).code !== "EPIPE") throw e; });
  const code = await exited;
  if (code !== 0) throw new Error(`psql stopped with code ${code}: ${err.trim().split("\n").slice(-4).join(" ")}`);
}

/** Read NDJSON dump lines from a gzipped plaintext stream. */
export async function* dumpLines(gz: Readable): AsyncGenerator<Record<string, unknown>> {
  let rest = "";
  for await (const chunk of gz.pipe(createGunzip())) {
    const text = rest + (chunk as Buffer).toString("utf8");
    const parts = text.split("\n");
    rest = parts.pop() ?? "";
    for (const p of parts) if (p) yield JSON.parse(p) as Record<string, unknown>;
  }
  if (rest.trim()) yield JSON.parse(rest) as Record<string, unknown>;
}

/**
 * Load a JSON dump into a database whose schema (migrations) is already in place. Every table is emptied first,
 * then filled from the dump; foreign keys and triggers are paused (session_replication_role = replica, which needs
 * a superuser), and only columns both sides have are copied, so a dump from a slightly older schema still loads.
 * Runs in one transaction: all or nothing.
 */
export async function jsonRestore(sql: postgres.Sql, gz: Readable, log: (s: string) => void = () => {}): Promise<Record<string, number>> {
  const target = new Map((await listTables(sql)).map((t) => [`${t.schema}.${t.name}`, t]));
  const counts: Record<string, number> = {};
  let ended = false;
  await sql.begin(async (tx) => {
    await tx.unsafe(`set local session_replication_role = replica`);
    // Empty everything first, in one statement (truncating table by table would cascade into tables already loaded).
    if (target.size) await tx.unsafe(`truncate ${[...target.values()].map((t) => `${q(t.schema)}.${q(t.name)}`).join(", ")} cascade`);
    let current: { key: string; cols: string[] } | null = null;
    let batch: unknown[] = [];
    const flush = async () => {
      if (!current || !batch.length) return;
      const [schema, name] = current.key.split(".");
      const cols = current.cols.map(q).join(", ");
      await tx.unsafe(`insert into ${q(schema)}.${q(name)} (${cols}) select ${cols} from json_populate_recordset(null::${q(schema)}.${q(name)}, $1::text::json)`,
        [JSON.stringify(batch)]);
      counts[current.key] = (counts[current.key] ?? 0) + batch.length;
      batch = [];
    };
    for await (const line of dumpLines(gz)) {
      if ("$format" in line) continue;
      if ("$end" in line) { ended = true; continue; }
      if ("$table" in line) {
        await flush();
        const t = line.$table as TableInfo;
        const key = `${t.schema}.${t.name}`;
        const there = target.get(key);
        if (!there) { log(`skipping ${key}: not in this database`); current = null; continue; }
        const cols = t.columns.filter((c) => there.columns.includes(c));
        current = { key, cols };
        counts[key] = 0;
        log(`restoring ${key}`);
        continue;
      }
      if (!current) continue;
      batch.push(line);
      if (batch.length >= 500) await flush();
    }
    await flush();
    if (!ended) throw new Error("The backup's database file ends early (it was cut off while it was written).");
    // Serial columns (the migrations table) continue after the restored rows.
    await tx.unsafe(`
      do $$ declare r record; begin
        for r in select s.relname as seq, n.nspname as ns, t.relname as tbl, a.attname as col
          from pg_class s join pg_depend d on d.objid = s.oid and d.deptype = 'a'
          join pg_class t on t.oid = d.refobjid join pg_attribute a on a.attrelid = t.oid and a.attnum = d.refobjsubid
          join pg_namespace n on n.oid = t.relnamespace where s.relkind = 'S' and n.nspname in ('public', 'drizzle')
        loop
          execute format('select setval(%L, coalesce((select max(%I) from %I.%I), 0) + 1, false)', r.ns || '.' || r.seq, r.col, r.ns, r.tbl);
        end loop;
      end $$`);
  });
  return counts;
}
