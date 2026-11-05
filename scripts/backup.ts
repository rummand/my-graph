/**
 * Take a backup now, the same way the nightly one runs: `npx tsx scripts/backup.ts`.
 * Reads DATABASE_URL, UPLOAD_DIR, BACKUP_DIR, BACKUP_KEY and the BACKUP_S3_* settings from the environment (or .env).
 * Prints where it went; exits 1 when it failed. See src/lib/backup/README.md.
 */
import { existsSync } from "node:fs";
import path from "node:path";

const envFile = path.resolve(process.cwd(), ".env");
if (existsSync(envFile) && typeof process.loadEnvFile === "function") process.loadEnvFile(envFile);
process.env.DATA_SAFETY_SCHEDULER = "0";

async function main() {
  const { runBackup, backupDir, listBackups } = await import("@/lib/backup/run");
  const { sql } = await import("@/db");
  try {
    const r = await runBackup("script");
    if (!r.ok) {
      console.error(`Backup failed: ${r.error}`);
      process.exitCode = 1;
      return;
    }
    const b = (await listBackups()).find((x) => x.id === r.id);
    console.log(`Backup ${r.id} written to ${path.join(backupDir(), r.id)} in ${(r.durationMs / 1000).toFixed(1)} s`);
    if (b?.meta) {
      console.log(`  database: ${b.meta.database.format}, ${(b.meta.database.bytes / 1024).toFixed(0)} KB, ${Object.values(b.meta.database.tables).reduce((a, n) => a + n, 0)} rows`);
      console.log(`  uploads: ${b.meta.uploads.count} files listed (${b.meta.uploads.missing} missing on disk)`);
      if (b.meta.s3) console.log(`  S3: ${b.meta.s3.uploaded ? `uploaded, ${b.meta.s3.filesCopied ?? 0} new files copied` : `failed: ${b.meta.s3.error}`}`);
      if (b.meta.encryption.developmentKey) console.log("  (encrypted with the development key: set BACKUP_KEY for real backups)");
      if (b.meta.note) console.log(`  note: ${b.meta.note}`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("Backup failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
