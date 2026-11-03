/**
 * Defensive reader for GET /api/nodes/[id] (owned by GBrain): { node, neighbours, edges, provenance: { node, edges } }.
 * Anything missing or oddly shaped is skipped rather than crashing the drawer. Pure — used by the client drawer.
 */
import { activityLabel, locatorLabel } from "@/components/provenance/labels";

export type DrawerSource = {
  key: string;
  sourceId: string | null;
  title: string;
  /** "page 3" etc. */
  detail?: string;
  confidence: number | null;
  quote: string | null;
  /** "Picked out by the assistant" etc. */
  how: string | null;
};

export type DrawerDetail = {
  summary: string | null;
  sources: DrawerSource[];
  /** Places, topics and documents linked to the event (people are shown separately). */
  related: { id: string; type: string; label: string }[];
};

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function parseNodeDetail(body: unknown): DrawerDetail {
  const root = obj(body) ?? {};
  const node = obj(root.node);
  const prov = obj(root.provenance);
  const nodeProv = Array.isArray(root.provenance) ? root.provenance : arr(prov?.node);

  // One citation per source (keep the most confident passage); provenance without a source is a hand entry.
  const bySource = new Map<string, DrawerSource>();
  for (const raw of nodeProv) {
    const p = obj(raw);
    if (!p) continue;
    const sourceId = str(p.sourceId);
    const confidence = num(p.confidence);
    const locator = obj(p.locator) ?? {};
    const entry: DrawerSource = {
      key: sourceId ?? `prov:${str(p.id) ?? bySource.size}`,
      sourceId,
      title: str(p.sourceTitle) ?? (sourceId ? "Untitled document" : "Entered by hand"),
      detail: locatorLabel(locator as never) || undefined,
      confidence,
      quote: str(p.quote),
      how: str(p.activity) ? activityLabel(p.activity as string) : null,
    };
    if (!sourceId && entry.how === activityLabel("manual_edit") && !entry.quote) continue;
    const prev = bySource.get(entry.key);
    if (!prev || (confidence ?? 0) > (prev.confidence ?? 0)) bySource.set(entry.key, entry);
  }

  const related: DrawerDetail["related"] = [];
  const seen = new Set<string>();
  for (const raw of arr(root.neighbours)) {
    const n = obj(raw);
    const id = str(n?.id), type = str(n?.type), label = str(n?.label);
    if (!id || !type || !label || type === "person" || seen.has(id)) continue;
    seen.add(id);
    related.push({ id, type, label });
    if (related.length >= 12) break;
  }

  return { summary: str(node?.summary), sources: [...bySource.values()], related };
}
