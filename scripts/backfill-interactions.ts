/**
 * Derive interactions with people from everything already in the graph (src/lib/people/interactions/derive.ts):
 * `npx tsx scripts/backfill-interactions.ts [graphId]`. Idempotent: run it as often as you like.
 */
import { existsSync } from "node:fs";
import path from "node:path";

const envFile = path.resolve(process.cwd(), ".env");
if (existsSync(envFile) && typeof process.loadEnvFile === "function") process.loadEnvFile(envFile);

async function main() {
  const { backfillInteractions } = await import("@/lib/people/interactions/derive");
  const { sql } = await import("@/db");
  const out = await backfillInteractions(process.argv[2] || undefined);
  for (const [g, n] of Object.entries(out)) if (n.sources + n.events + n.edits) console.log(g, n);
  console.log("graphs:", Object.keys(out).length);
  await sql.end({ timeout: 5 });
}

main().catch((err) => {
  console.error("Backfill failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
