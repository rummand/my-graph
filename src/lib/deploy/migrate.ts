/**
 * Production database setup, run once per server start from `src/instrumentation.ts`.
 * - Always: make sure pgvector exists, then the GBrain search indexes and triggers (idempotent).
 * - When RUN_MIGRATIONS=1 (set on Railway): apply the SQL migrations in ./drizzle first. Local dev keeps using
 *   `npm run db:push`; do not set RUN_MIGRATIONS on a database that was created with push.
 */
import path from "node:path";
import { db, sql } from "@/db";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { ensureSearchIndexesOnce } from "@/lib/gbrain/setup";

export async function prepareDatabase(): Promise<void> {
  try {
    const [{ present }] = await sql<{ present: boolean }[]>`select exists(select 1 from pg_extension where extname = 'vector') as present`;
    if (!present) await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS vector`);
    if (process.env.RUN_MIGRATIONS === "1") {
      const migrationsFolder = path.resolve(process.env.MIGRATIONS_DIR || "./drizzle");
      await migrate(db, { migrationsFolder });
      console.log("[startup] migrations applied from", migrationsFolder);
    }
    const ok = await ensureSearchIndexesOnce();
    console.log(`[startup] search indexes ${ok ? "ready" : "not ready (will retry on first use)"}`);
  } catch (err) {
    // Never crash the server on boot; /api/health reports the database state.
    console.error("[startup] database setup failed:", err instanceof Error ? err.message : err);
  }
}
