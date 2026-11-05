/**
 * Restore a My Graph backup into a database.
 *
 *   npx tsx scripts/restore.ts <backup folder | backup id> --database-url <postgres url> [options]
 *
 *   <backup folder>        a folder with meta.json (e.g. /data/backups/20261104T020000Z-nightly)
 *   <backup id>            looked up in BACKUP_DIR, or with --from-s3 downloaded from the bucket first
 *   --database-url <url>   the database to restore into (default: RESTORE_DATABASE_URL). Never the live one by accident:
 *                          it must be empty, or pass --wipe to empty it first.
 *   --wipe                 drop everything in the target database first
 *   --from-s3              download the backup from BACKUP_S3_* first (into a temporary folder)
 *   --fetch-files          download uploads the target's UPLOAD_DIR is missing from the bucket
 *   --upload-dir <dir>     where the uploads are (default UPLOAD_DIR or ./data/uploads)
 *   --yes                  don't ask before starting
 *
 * Needs BACKUP_KEY (the key the backup was taken with). Backups taken with the development key restore only
 * outside production. A pg_dump backup needs `psql` on the PATH (PSQL_PATH to override).
 */
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";

const envFile = path.resolve(process.cwd(), ".env");
if (existsSync(envFile) && typeof process.loadEnvFile === "function") process.loadEnvFile(envFile);
process.env.DATA_SAFETY_SCHEDULER = "0";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(name);

async function main() {
  const target = process.argv[2];
  const url = arg("--database-url") ?? process.env.RESTORE_DATABASE_URL;
  if (!target || target.startsWith("--") || !url) {
    console.error("Usage: npx tsx scripts/restore.ts <backup folder | id> --database-url <postgres url> [--wipe] [--from-s3] [--fetch-files] [--yes]");
    process.exit(2);
  }
  const { backupSettings } = await import("@/lib/backup/policy");
  const { restoreBackup, downloadBackup, readMeta } = await import("@/lib/backup/restore");
  const { backupDir } = await import("@/lib/backup/run");
  const settings = backupSettings(process.env);

  let folder = existsSync(path.join(target, "meta.json")) ? path.resolve(target) : path.join(backupDir(), target);
  let tmp: string | null = null;
  if (flag("--from-s3")) {
    if (!settings.s3) throw new Error("Set BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_KEY and BACKUP_S3_SECRET to restore from the bucket.");
    tmp = await mkdtemp(path.join(os.tmpdir(), "mygraph-restore-"));
    console.log(`Downloading ${path.basename(target)} from the bucket…`);
    folder = await downloadBackup(settings.s3, path.basename(target), tmp);
  }
  if (!existsSync(path.join(folder, "meta.json"))) throw new Error(`No backup at ${folder}.`);

  const meta = await readMeta(folder);
  const safeUrl = url.replace(/(\/\/[^:/@]+:)[^@]+@/, "$1***@");
  console.log(`Backup ${meta.id} (${meta.database.format}, taken ${meta.createdAt}) → ${safeUrl}${flag("--wipe") ? " (emptied first)" : ""}`);
  if (!flag("--yes")) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question("Type 'restore' to go on: ");
    rl.close();
    if (answer.trim() !== "restore") { console.log("Stopped."); return; }
  }

  try {
    const report = await restoreBackup({
      folder, targetUrl: url, secret: process.env.BACKUP_KEY?.trim() || null, allowDevKey: process.env.NODE_ENV !== "production",
      wipe: flag("--wipe"),
      migrate: async (u) => {
        const { migrate } = await import("drizzle-orm/postgres-js/migrator");
        const { drizzle } = await import("drizzle-orm/postgres-js");
        const postgres = (await import("postgres")).default;
        const c = postgres(u, { max: 1, onnotice: () => {} });
        try {
          await c.unsafe("create extension if not exists vector");
          await migrate(drizzle(c), { migrationsFolder: path.resolve(process.env.MIGRATIONS_DIR || "./drizzle") });
        } finally {
          await c.end({ timeout: 5 });
        }
      },
      uploadDir: path.resolve(arg("--upload-dir") ?? process.env.UPLOAD_DIR ?? "./data/uploads"),
      fetchFiles: flag("--fetch-files") ? settings.s3 : null,
      log: (s) => console.log(`  ${s}`),
    });
    console.log(`Restored ${report.rows} rows in ${report.tables} tables.`);
    if (report.countMismatches.length) {
      console.log("Row counts that differ from the backup's own count (pg_dump counts are taken a moment before the dump):");
      for (const m of report.countMismatches) console.log(`  ${m.table}: expected ${m.expected}, restored ${m.actual}`);
    } else console.log("Every table has the row count the backup recorded.");
    const u = report.uploads;
    console.log(`Uploads: ${u.listed} listed, ${u.present} present${u.fetched ? `, ${u.fetched} downloaded` : ""}${u.missing ? `, ${u.missing} missing` : ""}.`);
    if (u.missing && !flag("--fetch-files")) console.log("  Copy the upload volume across, or run again with --fetch-files when the backup copied files to S3.");
    if (meta.database.format === "json") console.log("Next: start the app against this database; it rebuilds search indexes on start.");
    if (report.countMismatches.length && meta.database.format === "json") process.exitCode = 1;
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("Restore failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
