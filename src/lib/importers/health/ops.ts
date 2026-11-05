/**
 * Health records → proposals about the person themself (pure). Shared by the `health` importer (Apple Health, sent
 * by the iPhone app) and by sundhed.dk printouts (importers/dk/sundhed.ts). Everything is private to the person who
 * imports it; nothing is about anyone else. Agents propose, humans decide: every op has a receipt.
 *
 *   vaccination / visit / procedure / lab → a dated event that involves the person
 *   condition / allergy / medication      → a health topic linked to the person (diagnosed with / allergic to / takes)
 *   measurement                           → one summary per kind of measurement (latest value, range, how many), not
 *                                           one op per reading
 *   allergies also fill the person's "Allergies" field, only when it is still empty (never over what they wrote).
 */
import type { ChangeInput } from "@/lib/changes";
import type { TextSegment } from "@/lib/ingest/chunk";
import { edgeKey, matchByLabel, normName } from "../match";
import type { HealthPayload } from "../schemas";
import type { ImportKnown } from "../types";

export type HealthRecord = HealthPayload["records"][number];
export type HealthType = HealthRecord["type"];

export type HealthOpsContext = {
  sourceId: string;
  /** The importing person's own person node in this graph (Viewer.personNodeId). */
  selfNodeId: string | null | undefined;
  known: ImportKnown[];
  existingEdges: ReadonlySet<string>;
  mint(): string;
  locale: "en" | "da";
  /** Where a record was found (a page of a printout); the default points at the record's line in the import. */
  locatorOf?(r: HealthRecord): Record<string, unknown> | undefined;
  /** The text a record was read from, when it came from a document. */
  quoteOf?(r: HealthRecord): string | undefined;
};

export type HealthOpsResult = { changes: ChangeInput[]; counts: Record<string, number>; warnings: string[]; segments: TextSegment[] };

/** Caps, so a large export stays a reviewable proposal. */
export const HEALTH_CAPS = { events: 300, labs: 150, topics: 150, measurementKinds: 15 } as const;

const WORDS: Record<"en" | "da", Record<HealthType, string>> = {
  en: { vaccination: "Vaccination", condition: "Condition", medication: "Medication", allergy: "Allergy", lab: "Lab result", measurement: "Measurement", procedure: "Procedure", visit: "Visit" },
  da: { vaccination: "Vaccination", condition: "Diagnose", medication: "Medicin", allergy: "Allergi", lab: "Prøvesvar", measurement: "Måling", procedure: "Behandling", visit: "Besøg" },
};

/** Relations the health ops use (the same keys the practice template uses, so a household has one of each). */
const RELATIONS = {
  diagnosed_with: { label: "diagnosed with", inverseLabel: "diagnosis of" },
  allergic_to: { label: "allergic to", inverseLabel: "allergy of" },
  takes: { label: "takes", inverseLabel: "taken by" },
} as const;
type HealthRelation = keyof typeof RELATIONS;
const TOPIC_RELATION: Partial<Record<HealthType, HealthRelation>> = { condition: "diagnosed_with", allergy: "allergic_to", medication: "takes" };

const day = (iso: string | undefined) => (iso ? iso.slice(0, 10) : null);
const num = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));
const valueText = (r: Pick<HealthRecord, "value" | "unit">) => (r.value !== undefined ? `${num(r.value)}${r.unit ? ` ${r.unit}` : ""}` : "");

/** One line per record: what the source's searchable text says, and what a receipt quotes. */
export function recordLine(r: HealthRecord, locale: "en" | "da"): string {
  return [WORDS[locale][r.type], r.name, valueText(r), day(r.at), r.note?.replace(/\s+/g, " ").slice(0, 300)].filter(Boolean).join(" — ");
}

type MeasureSummary = { name: string; unit: string | undefined; count: number; min: number; max: number; latest: HealthRecord; first: string | null };

function summariseMeasurements(rs: HealthRecord[]): MeasureSummary[] {
  const groups = new Map<string, HealthRecord[]>();
  for (const r of rs) {
    if (r.value === undefined || !Number.isFinite(r.value)) continue;
    const k = `${normName(r.name)}|${r.unit ?? ""}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }
  const out: MeasureSummary[] = [];
  for (const g of groups.values()) {
    g.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
    const values = g.map((r) => r.value!);
    out.push({ name: g[0].name, unit: g[0].unit, count: g.length, min: Math.min(...values), max: Math.max(...values), latest: g[g.length - 1], first: day(g[0].at) });
  }
  return out.sort((a, b) => b.count - a.count);
}

export function healthOps(records: HealthRecord[], ctx: HealthOpsContext): HealthOpsResult {
  const L = ctx.locale;
  const changes: ChangeInput[] = [];
  const warnings: string[] = [];
  const counts: Record<string, number> = { vaccinations: 0, conditions: 0, medications: 0, allergies: 0, labs: 0, visits: 0, procedures: 0, measurements: 0 };
  const self = ctx.selfNodeId ?? null;
  const selfNode = self ? ctx.known.find((k) => k.id === self) ?? null : null;
  if (!self) warnings.push("Your own person page wasn't found in this graph, so the health entries aren't linked to you. Link them after delivering.");
  const receipt = (r: HealthRecord, confidence = 0.95) => ({
    sourceId: ctx.sourceId, quote: (ctx.quoteOf?.(r) ?? recordLine(r, L)).slice(0, 400), locator: ctx.locatorOf?.(r) ?? { range: `record:${r.id}` }, confidence,
  });
  const usedRelations = new Set<HealthRelation>();
  const edgeOnce = new Set<string>();
  const link = (fromId: string, toId: string, relation: string, r: HealthRecord, note: string) => {
    const k = edgeKey(fromId, relation, toId);
    if (ctx.existingEdges.has(k) || edgeOnce.has(k)) return;
    edgeOnce.add(k);
    changes.push({ op: "addEdge", edgeId: ctx.mint(), fromId, toId, relation, confidence: 0.95, note, receipt: receipt(r) });
  };

  // Newest first, so caps keep what matters now.
  const sorted = [...records].sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));

  // Events: vaccinations, visits, procedures, lab results.
  const knownEvents = new Set(ctx.known.filter((k) => k.type === "event").map((k) => `${normName(k.label)}|${day(k.startAt ?? undefined) ?? ""}`));
  const seenEvents = new Set<string>();
  let events = 0, labs = 0, skippedEvents = 0;
  for (const r of sorted) {
    if (r.type !== "vaccination" && r.type !== "visit" && r.type !== "procedure" && r.type !== "lab") continue;
    const label = `${WORDS[L][r.type]}: ${r.name}${r.type === "lab" && r.value !== undefined ? ` ${valueText(r)}` : ""}`.slice(0, 200);
    const key = `${normName(label)}|${day(r.at) ?? ""}`;
    if (knownEvents.has(key) || seenEvents.has(key)) continue;
    if (events >= HEALTH_CAPS.events || (r.type === "lab" && labs >= HEALTH_CAPS.labs)) { skippedEvents++; continue; }
    seenEvents.add(key);
    events++;
    if (r.type === "lab") labs++;
    const id = ctx.mint();
    const props: Record<string, unknown> = { health: r.type, healthId: r.id };
    if (r.value !== undefined) props.value = r.value;
    if (r.unit) props.unit = r.unit;
    changes.push({
      op: "addNode", nodeId: id, type: "event", kind: r.type === "lab" ? null : "appointment", label,
      summary: r.note?.slice(0, 500), props, startAt: r.at ?? null, visibility: "private", sensitive: true,
      note: `From your health records (${WORDS.en[r.type].toLowerCase()}).`, receipt: receipt(r),
    });
    if (self) link(id, self, "involves", r, `${WORDS.en[r.type]} for the person who imported it.`);
    counts[r.type === "vaccination" ? "vaccinations" : r.type === "visit" ? "visits" : r.type === "procedure" ? "procedures" : "labs"]++;
  }
  if (skippedEvents) warnings.push(`${skippedEvents} older entries were left out to keep this proposal reviewable; they are still searchable in the import.`);

  // Topics: conditions, allergies, medications (one per name, the newest record's details).
  const topicIds = new Map<string, string>();
  let topics = 0;
  const allergyNames: string[] = [];
  for (const r of sorted) {
    const rel = TOPIC_RELATION[r.type];
    if (!rel) continue;
    const nk = `${r.type}|${normName(r.name)}`;
    if (!normName(r.name) || topicIds.has(nk)) continue;
    if (r.type === "allergy") allergyNames.push(r.name);
    const hit = matchByLabel(ctx.known, "topic", r.name);
    let id = hit?.id ?? null;
    if (!id) {
      if (topics >= HEALTH_CAPS.topics) continue;
      topics++;
      id = ctx.mint();
      const props: Record<string, unknown> = { health: r.type, healthId: r.id };
      if (r.at) props.since = day(r.at);
      if (r.value !== undefined) props.dose = valueText(r);
      changes.push({
        op: "addNode", nodeId: id, type: "topic", kind: "health", label: r.name.slice(0, 200),
        summary: r.note?.slice(0, 500), props, visibility: "private", sensitive: true,
        note: `From your health records (${WORDS.en[r.type].toLowerCase()}).`, receipt: receipt(r),
      });
    }
    topicIds.set(nk, id);
    counts[r.type === "condition" ? "conditions" : r.type === "allergy" ? "allergies" : "medications"]++;
    if (self) {
      usedRelations.add(rel);
      link(self, id, rel, r, `${RELATIONS[rel].label} — from the person's own health records.`);
    }
  }

  // The person's "Allergies" field: filled only when empty.
  // Only when the person's own node (with its fields) is known: an unknown field is never taken for an empty one.
  if (self && selfNode && allergyNames.length) {
    const current = selfNode.props.allergies;
    if (typeof current !== "string" || !current.trim()) {
      const first = sorted.find((r) => r.type === "allergy")!;
      changes.push({ op: "updateNode", nodeId: self, set: { props: { allergies: allergyNames.join(", ").slice(0, 1000) } }, note: "Your allergies field was empty.", receipt: receipt(first) });
    } else {
      const missing = allergyNames.filter((a) => !normName(current).includes(normName(a)));
      if (missing.length) warnings.push(`Your allergies field already says "${current.slice(0, 80)}"; it was left as you wrote it (not mentioned there: ${missing.join(", ")}).`);
    }
  }

  // Measurements: a summary per kind, the latest value dated at the latest reading.
  const measures = summariseMeasurements(sorted.filter((r) => r.type === "measurement"));
  const segmentsExtra: string[] = [];
  for (const m of measures) {
    const range = m.count > 1 ? (L === "da" ? `${m.count} målinger${m.first ? ` siden ${m.first}` : ""}, fra ${num(m.min)} til ${num(m.max)}${m.unit ? ` ${m.unit}` : ""}` : `${m.count} readings${m.first ? ` since ${m.first}` : ""}, from ${num(m.min)} to ${num(m.max)}${m.unit ? ` ${m.unit}` : ""}`) : "";
    segmentsExtra.push(`${m.name}: ${valueText(m.latest)}${m.latest.at ? ` (${day(m.latest.at)})` : ""}${range ? `; ${range}` : ""}`);
  }
  for (const m of measures.slice(0, HEALTH_CAPS.measurementKinds)) {
    const label = `${m.name}: ${valueText(m.latest)}`.slice(0, 200);
    if (knownEvents.has(`${normName(label)}|${day(m.latest.at) ?? ""}`)) continue;
    const id = ctx.mint();
    changes.push({
      op: "addNode", nodeId: id, type: "event", kind: null, label,
      summary: m.count > 1 ? (L === "da" ? `Seneste af ${m.count} målinger; laveste ${num(m.min)}, højeste ${num(m.max)}.` : `Latest of ${m.count} readings; lowest ${num(m.min)}, highest ${num(m.max)}.`) : undefined,
      props: { health: "measurement", value: m.latest.value, unit: m.unit ?? null, readings: m.count, min: m.min, max: m.max, from: m.first, to: day(m.latest.at) },
      startAt: m.latest.at ?? null, visibility: "private", sensitive: true,
      note: `A summary of ${m.count} ${m.name} reading${m.count === 1 ? "" : "s"}, not every reading.`, receipt: receipt(m.latest, 0.9),
    });
    if (self) link(id, self, "involves", m.latest, "A measurement of the person who imported it.");
    counts.measurements++;
  }
  if (measures.length > HEALTH_CAPS.measurementKinds) warnings.push(`Only the ${HEALTH_CAPS.measurementKinds} most frequent kinds of measurement are proposed; the rest are in the import's text.`);

  // Meta model: the relations used, once each (delivering one that exists already only counts the evidence).
  const meta: ChangeInput[] = [...usedRelations].map((key) => ({
    op: "addRelationType", key, label: RELATIONS[key].label, inverseLabel: RELATIONS[key].inverseLabel, fromTypes: ["person"], toTypes: ["topic", "thing"], category: "care",
    note: "Used by health records.", receipt: { sourceId: ctx.sourceId, confidence: 1 },
  }));

  // Searchable text: one segment per kind of record, measurements summarised.
  const segments: TextSegment[] = [];
  const order: HealthType[] = ["condition", "allergy", "medication", "vaccination", "visit", "procedure", "lab"];
  for (const t of order) {
    const lines = sorted.filter((r) => r.type === t).map((r) => recordLine(r, L));
    for (let i = 0; i < lines.length; i += 80) segments.push({ text: `${WORDS[L][t]}\n${lines.slice(i, i + 80).join("\n")}`, at: { region: `health:${t}` } });
  }
  if (segmentsExtra.length) segments.push({ text: `${WORDS[L].measurement}\n${segmentsExtra.join("\n")}`, at: { region: "health:measurement" } });

  return { changes: [...meta, ...changes], counts, warnings, segments };
}
