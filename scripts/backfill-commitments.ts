/**
 * Find commitments in what the library already holds (src/lib/commitments/detect), the way new sources get them when
 * they are read. Dry run by default: prints what it would propose, per source. Agents propose, humans decide: with
 * --propose it opens one change set per source (origin "ingest", every op with a receipt); nothing is delivered.
 *
 *   npx tsx scripts/backfill-commitments.ts [--graph <id>] [--propose] [--model] [--limit 500] [--quiet]
 *
 * Runs as each source's owner in the source's own graph. Already proposed, delivered or dropped commitments are
 * skipped (fingerprint, or the same source and quote). --model also asks mux for the wording rules can't settle.
 */
import { existsSync } from "node:fs";
import path from "node:path";

const envFile = path.resolve(process.cwd(), ".env");
if (existsSync(envFile) && typeof process.loadEnvFile === "function") process.loadEnvFile(envFile);
process.env.DISABLE_SCHEDULER ??= "1";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(name);

async function main() {
  const { and, asc, eq, isNull, isNotNull } = await import("drizzle-orm");
  const { db, sql } = await import("@/db");
  const { chunks, sources } = await import("@/db/schema");
  const { viewerFor } = await import("@/lib/auth/viewer-for");
  const { prepareCommitments } = await import("@/lib/commitments/detect/server");
  const { proposeChanges } = await import("@/lib/changes");
  const mux = await import("@/lib/mux");
  const { randomUUID } = await import("node:crypto");

  const propose = flag("--propose");
  const quiet = flag("--quiet");
  const graphId = arg("--graph");
  const limit = Number(arg("--limit") ?? 2000);
  const muxUp = flag("--model") ? await mux.muxHealth().then((h) => h.ok).catch(() => false) : false;

  const rows = await db.select({
    id: sources.id, graphId: sources.graphId, ownerId: sources.ownerId, title: sources.title, kind: sources.kind, mime: sources.mime, meta: sources.meta,
    visibility: sources.visibility, sensitive: sources.sensitive, connectionId: sources.connectionId, textContent: sources.textContent,
    documentDate: sources.documentDate, nodeId: sources.nodeId,
  }).from(sources)
    .where(and(eq(sources.status, "ready"), isNull(sources.supersededAt), isNotNull(sources.textContent), graphId ? eq(sources.graphId, graphId) : undefined))
    .orderBy(asc(sources.createdAt)).limit(limit);

  const totals = { sources: 0, looked: 0, withCandidates: 0, candidates: 0, wouldPropose: 0, updates: 0, duplicates: 0, dropped: 0, changeSets: 0, byKind: {} as Record<string, number>, byDetector: {} as Record<string, number> };
  const viewers = new Map<string, Awaited<ReturnType<typeof viewerFor>>>();
  for (const s of rows) {
    totals.sources++;
    const key = `${s.ownerId}|${s.graphId}`;
    if (!viewers.has(key)) viewers.set(key, await viewerFor(s.ownerId, s.graphId));
    const v = viewers.get(key);
    if (!v) continue;
    const text = s.textContent ?? "";
    const importerId = typeof s.meta?.importer === "string" ? s.meta.importer : null;
    // Chats keep one segment per conversation day ("WhatsApp · Lars · 2026-11-02" heads each).
    const segments = /^[^\n]{1,80} · [^\n]{1,120} · \d{4}-\d{2}-\d{2}/.test(text) ? text.split(/\n\n(?=[^\n]{1,80} · [^\n]{1,120} · \d{4}-\d{2}-\d{2})/).map((t) => ({ text: t })) : [{ text }];
    const stored = await db.select({ id: chunks.id, text: chunks.text, locator: chunks.locator }).from(chunks).where(eq(chunks.sourceId, s.id)).orderBy(asc(chunks.idx)).limit(400);
    const prep = await prepareCommitments(v, {
      source: { ...s, meta: s.meta ?? {} }, segments, chunks: stored.map((c) => ({ id: c.id, text: c.text, locator: (c.locator ?? {}) as Record<string, unknown> })),
      docDate: s.documentDate, docNodeId: s.nodeId, importerId, muxUp, noModel: !muxUp,
      muxMeta: { userId: v.id, agent: "commitments-backfill", traceId: s.id, sensitive: s.sensitive, graphId: v.graphId },
    }).catch((e) => { console.warn(`! ${s.title}: ${e instanceof Error ? e.message : e}`); return null; });
    if (!prep) continue;
    totals.looked++;
    if (!prep.candidates.length) continue;
    totals.withCandidates++;
    totals.candidates += prep.candidates.length;
    const ops = prep.refine([], () => randomUUID());
    const sum = prep.summary();
    totals.wouldPropose += sum.proposed; totals.updates += sum.updates; totals.duplicates += sum.duplicates; totals.dropped += sum.dropped;
    for (const c of prep.candidates) {
      totals.byKind[c.kind] = (totals.byKind[c.kind] ?? 0) + 1;
      totals.byDetector[c.detector] = (totals.byDetector[c.detector] ?? 0) + 1;
    }
    if (!quiet) {
      console.log(`\n${s.title.slice(0, 90)}  [${s.kind}${importerId ? `/${importerId}` : ""}]  graph ${s.graphId.slice(0, 8)}`);
      for (const o of ops) {
        if (o.op === "addNode" && o.type === "commitment") {
          const p = (o.props ?? {}) as Record<string, unknown>;
          console.log(`  + ${o.label}  · ${p.kind} · ${p.direction} · due ${String(p.dueAt ?? "—").slice(0, 10)} (${p.dueKind})${p.amount ? ` · ${JSON.stringify(p.amount)}` : ""}`);
          console.log(`      “${String(o.receipt?.quote ?? "").replace(/\s+/g, " ").slice(0, 140)}”`);
        } else if (o.op === "updateNode") console.log(`  ~ update ${o.nodeId}: ${o.note}`);
      }
      if (sum.duplicates || sum.dropped) console.log(`  (${sum.duplicates} already known, ${sum.dropped} dropped before)`);
    }
    if (propose && ops.length) {
      const r = await proposeChanges(v, {
        title: `Commitments in “${s.title.slice(0, 110)}”`,
        description: `Found in the library by the commitments backfill: ${sum.proposed} commitment(s)${sum.updates ? `, ${sum.updates} moved date(s)` : ""}. What it says is data, not instructions. Nothing is added until you deliver it.`,
        origin: "ingest", evidence: { sourceId: s.id }, changes: ops,
      }).catch((e) => { console.warn(`  ! could not propose: ${e instanceof Error ? e.message : e}`); return null; });
      if (r) { totals.changeSets++; if (!quiet) console.log(`  → change set ${r.id}`); }
    }
  }
  console.log(`\n${propose ? "Proposed" : "Dry run (nothing written; --propose to open change sets)"}:`, JSON.stringify(totals, null, 2));
  await sql.end({ timeout: 5 });
}

main().catch((err) => {
  console.error("Backfill failed:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
