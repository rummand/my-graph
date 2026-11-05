import { describe, expect, it } from "vitest";
import type { ImportContext, ImportKnown } from "../types";
import { healthImporter } from "./index";
import { healthOps, type HealthRecord } from "./ops";

const self: ImportKnown = { id: "me", type: "person", kind: null, label: "Anna", aliases: [], startAt: null, props: {} };

function ctx(over: Partial<ImportContext> = {}): ImportContext {
  let n = 0;
  return {
    sourceId: "s1", graphKind: "personal", visibility: "household", known: [self], existingEdges: new Set(), now: new Date("2026-11-05T10:00:00Z"),
    mint: () => `id-${++n}`, locale: "en", selfNodeId: "me", ...over,
  };
}

const records: HealthRecord[] = [
  { id: "v1", type: "vaccination", name: "MMR", at: "2019-05-01T10:00:00Z" },
  { id: "c1", type: "condition", name: "Asthma", at: "2010-01-01T00:00:00Z" },
  { id: "m1", type: "medication", name: "Ventoline", value: 0.1, unit: "mg" },
  { id: "a1", type: "allergy", name: "Hazelnuts" },
  { id: "l1", type: "lab", name: "HbA1c", value: 38, unit: "mmol/mol", at: "2026-10-01T08:00:00Z" },
  { id: "vis", type: "visit", name: "GP check-up", at: "2026-09-12T09:00:00Z" },
  ...Array.from({ length: 2000 }, (_, i): HealthRecord => ({ id: `w${i}`, type: "measurement", name: "Weight", value: 70 + (i % 50) / 10, unit: "kg", at: new Date(Date.UTC(2024, 0, 1) + i * 3600_000).toISOString() })),
  { id: "hr", type: "measurement", name: "Resting heart rate", value: 58, unit: "bpm", at: "2026-11-01T06:00:00Z" },
];

function run(c = ctx(), rs = records) {
  return healthImporter.read({ filename: "health.json", bytes: Buffer.from(JSON.stringify({ records: rs })) }, c) as Awaited<ReturnType<typeof healthImporter.read>>;
}

describe("health importer", () => {
  it("is sensitive, takes JSON only, and never claims an uploaded file", () => {
    expect(healthImporter.sensitive).toBe(true);
    expect(healthImporter.json).toBeDefined();
    expect(healthImporter.detect({ filename: "health.json", head: new Uint8Array() })).toBe(false);
  });

  it("proposes private entries about the person themself, with receipts", () => {
    const plan = run();
    expect(plan.extract).toBe(false);
    const nodes = plan.changes.filter((c) => c.op === "addNode");
    expect(nodes.every((c) => c.op === "addNode" && c.visibility === "private")).toBe(true);
    expect(plan.changes.every((c) => c.receipt?.sourceId === "s1")).toBe(true);
    expect(plan.counts).toMatchObject({ vaccinations: 1, conditions: 1, medications: 1, allergies: 1, labs: 1, visits: 1, measurements: 2 });
    const edges = plan.changes.filter((c) => c.op === "addEdge");
    expect(edges.map((e) => e.op === "addEdge" && e.relation).sort()).toEqual(["allergic_to", "diagnosed_with", "involves", "involves", "involves", "involves", "involves", "takes"]);
    expect(edges.every((e) => e.op === "addEdge" && (e.fromId === "me" || e.toId === "me"))).toBe(true);
    expect(plan.changes.filter((c) => c.op === "addRelationType").map((c) => c.op === "addRelationType" && c.key).sort()).toEqual(["allergic_to", "diagnosed_with", "takes"]);
  });

  it("summarises measurements instead of proposing every reading", () => {
    const plan = run();
    expect(plan.changes.length).toBeLessThan(30);
    const weight = plan.changes.find((c) => c.op === "addNode" && c.label.startsWith("Weight"));
    expect(weight).toMatchObject({ props: { readings: 2000, min: 70, max: 74.9 } });
    expect(plan.segments.some((s) => s.text.includes("Weight") && s.text.includes("2000 readings"))).toBe(true);
  });

  it("fills an empty allergies field, and never one the person wrote", () => {
    const empty = run();
    expect(empty.changes.find((c) => c.op === "updateNode")).toMatchObject({ nodeId: "me", set: { props: { allergies: "Hazelnuts" } } });
    const written = run(ctx({ known: [{ ...self, props: { allergies: "Penicillin" } }] }));
    expect(written.changes.some((c) => c.op === "updateNode")).toBe(false);
    expect(written.warnings?.join(" ")).toContain("Penicillin");
  });

  it("doesn't propose what the graph already has", () => {
    const known: ImportKnown[] = [self, { id: "t1", type: "topic", kind: "health", label: "Asthma", aliases: [], startAt: null, props: {} }];
    const plan = run(ctx({ known, existingEdges: new Set(["me|diagnosed_with|t1"]) }));
    expect(plan.changes.some((c) => c.op === "addNode" && c.label === "Asthma")).toBe(false);
    expect(plan.changes.some((c) => c.op === "addEdge" && c.toId === "t1")).toBe(false);
  });

  it("without the person's own node, proposes entries unlinked and says so", () => {
    const plan = run(ctx({ selfNodeId: null }));
    expect(plan.changes.some((c) => c.op === "addEdge")).toBe(false);
    expect(plan.warnings?.[0]).toContain("person page");
  });

  it("writes its own words in Danish for a Danish reader", () => {
    const r = healthOps(records.slice(0, 1), { sourceId: "s1", selfNodeId: "me", known: [self], existingEdges: new Set(), mint: () => "x", locale: "da" });
    expect(r.changes.find((c) => c.op === "addNode")).toMatchObject({ label: "Vaccination: MMR" });
    const visit = healthOps([records[5]], { sourceId: "s1", selfNodeId: "me", known: [self], existingEdges: new Set(), mint: () => "y", locale: "da" });
    expect(visit.changes.find((c) => c.op === "addNode")).toMatchObject({ label: "Besøg: GP check-up" });
  });
});
