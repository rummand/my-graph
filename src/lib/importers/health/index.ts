/**
 * The `health` importer: what a person chose to share from Apple Health, sent by the iPhone app to
 * POST /api/import/health (healthPayload). Always sensitive (never leaves for a model without no-fallback) and every
 * entry is a private proposal about the person themself. Pure.
 */
import { healthPayload, type HealthPayload } from "../schemas";
import type { Importer } from "../types";
import { healthOps } from "./ops";

export const healthImporter: Importer = {
  id: "health",
  label: "Health records",
  mime: "application/vnd.mygraph.health+json",
  // Only arrives as a JSON batch from the iPhone app; an uploaded file is never taken for health data.
  detect: () => false,
  json: healthPayload,
  sensitive: true,
  privateOnly: true,
  graphKinds: ["family", "personal", "partner"],
  read(input, ctx) {
    let data: HealthPayload;
    try {
      data = healthPayload.parse(JSON.parse(input.bytes.toString("utf8")));
    } catch {
      return { segments: [], changes: [], counts: {}, warnings: ["These health records aren't in the expected shape."], extract: false };
    }
    const r = healthOps(data.records, {
      sourceId: ctx.sourceId, selfNodeId: ctx.selfNodeId, known: ctx.known, existingEdges: ctx.existingEdges, mint: ctx.mint, locale: ctx.locale,
    });
    const latest = data.records.reduce<string | null>((m, x) => (x.at && (!m || x.at > m) ? x.at : m), null);
    const n = data.records.length;
    return {
      segments: r.segments,
      changes: r.changes,
      counts: r.counts,
      warnings: r.warnings,
      title: ctx.locale === "da" ? `Helbredsdata fra iPhone: ${n} ${n === 1 ? "post" : "poster"}` : `Health records from iPhone: ${n} ${n === 1 ? "entry" : "entries"}`,
      occurredAt: latest ? new Date(latest) : null,
      // Structured already: no model reads it.
      extract: false,
    };
  },
};
