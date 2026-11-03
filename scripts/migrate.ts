/**
 * Apply the SQL migrations in ./drizzle to DATABASE_URL, the same way production does on start (RUN_MIGRATIONS=1):
 * `npx tsx scripts/migrate.ts`. Use it on a database created from migrations, not one created with `db:push`.
 */
import { existsSync } from "node:fs";
import path from "node:path";

const envFile = path.resolve(process.cwd(), ".env");
if (existsSync(envFile) && typeof process.loadEnvFile === "function") process.loadEnvFile(envFile);
process.env.RUN_MIGRATIONS = "1";

async function main() {
  const { prepareDatabase } = await import("@/lib/deploy/migrate");
  const { sql } = await import("@/db");
  await prepareDatabase();
  await sql.end({ timeout: 5 });
}

main().catch((err) => {
  console.error("Migration failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
