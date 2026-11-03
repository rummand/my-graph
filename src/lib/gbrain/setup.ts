/**
 * Idempotent database setup that drizzle-kit does not express: search indexes, vector indexes and the triggers that
 * keep `nodes.search` and `chunks.search` up to date. Safe to run many times and from several processes at once
 * (guarded by an advisory lock). GBrain calls it lazily once per process; scripts can call it directly.
 */
import { sql as pg } from "@/db";

const STATEMENTS = [
  // Full-text: 'simple' config so Danish (and any language) is indexed word-for-word.
  `CREATE OR REPLACE FUNCTION gbrain_nodes_search() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     NEW.search :=
       setweight(to_tsvector('simple', coalesce(NEW.label, '')), 'A') ||
       setweight(to_tsvector('simple', array_to_string(coalesce(NEW.aliases, '{}'::text[]), ' ')), 'A') ||
       setweight(to_tsvector('simple', coalesce(NEW.summary, '')), 'B');
     RETURN NEW;
   END $$`,
  `CREATE OR REPLACE TRIGGER nodes_search_trg BEFORE INSERT OR UPDATE OF label, aliases, summary ON nodes
   FOR EACH ROW EXECUTE FUNCTION gbrain_nodes_search()`,
  `CREATE OR REPLACE FUNCTION gbrain_chunks_search() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     NEW.search := to_tsvector('simple', coalesce(NEW.text, ''));
     RETURN NEW;
   END $$`,
  `CREATE OR REPLACE TRIGGER chunks_search_trg BEFORE INSERT OR UPDATE OF text ON chunks
   FOR EACH ROW EXECUTE FUNCTION gbrain_chunks_search()`,
  // Backfill rows written before the triggers existed.
  `UPDATE nodes SET label = label WHERE search IS NULL`,
  `UPDATE chunks SET text = text WHERE search IS NULL`,
  `CREATE INDEX IF NOT EXISTS nodes_search_gin ON nodes USING gin (search)`,
  `CREATE INDEX IF NOT EXISTS chunks_search_gin ON chunks USING gin (search)`,
  `CREATE INDEX IF NOT EXISTS nodes_embedding_hnsw ON nodes USING hnsw (embedding vector_cosine_ops)`,
  `CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw ON chunks USING hnsw (embedding vector_cosine_ops)`,
  // Access and dedup lookups.
  `CREATE INDEX IF NOT EXISTS edges_dedup_idx ON edges (owner_id, from_id, relation, to_id)`,
  `CREATE INDEX IF NOT EXISTS shares_user_node_idx ON shares (user_id, node_id)`,
  `CREATE INDEX IF NOT EXISTS nodes_household_vis_idx ON nodes (household_id, visibility) WHERE merged_into IS NULL`,
];

/** Runs every statement in one transaction under an advisory lock. */
export async function ensureSearchIndexes(): Promise<void> {
  await pg.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('gbrain_setup'))`;
    await tx.unsafe(`SET LOCAL client_min_messages = warning`); // silence "already exists, skipping"
    for (const s of STATEMENTS) await tx.unsafe(s);
  });
}

let ready: Promise<boolean> | null = null;

/** Once per process; never throws. Failure is logged and retried on the next call. */
export function ensureSearchIndexesOnce(): Promise<boolean> {
  if (!ready) {
    ready = ensureSearchIndexes().then(
      () => true,
      (err) => {
        console.error("[gbrain] search index setup failed:", err instanceof Error ? err.message : err);
        ready = null;
        return false;
      },
    );
  }
  return ready;
}
