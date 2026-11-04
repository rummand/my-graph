import { describe, expect, it } from "vitest";
import type { ChangeInput } from "@/lib/changes";
import { parseExtraction } from "./extraction";
import { buildProposalOps, correspondentOps, describeCounts, edgeKey, type KnownNode } from "./proposals";

const chunk = { id: "c1", idx: 0, text: "Kære forældre. Emma skal på tur til Zoo den 14. oktober 2026. Hilsen Bo Hansen", locator: { page: 1 } };
const ex = parseExtraction({
  documentDate: "2026-10-01", documentDatePrecision: "day",
  entities: [
    { type: "person", label: "Emma" },
    { type: "person", label: "Bo Hansen", summary: "class teacher" },
    { type: "event", label: "Tur til Zoo", startAt: "2026-10-14T08:00:00+02:00", precision: "minute" },
    { type: "place", label: "Zoo" },
  ],
  facts: [
    { from: "Tur til Zoo", relation: "involves", to: "Emma", quote: "Emma skal på tur til Zoo", confidence: 0.9 },
    { from: "Tur til Zoo", relation: "happened_at", to: "Zoo", quote: "tur til Zoo", confidence: 0.9 },
  ],
});
const known: KnownNode[] = [{ id: "emma", type: "person", label: "Emma Jensen", aliases: [] }];
let n = 0;
const mint = () => `new-${++n}`;
const base = { sourceId: "s1", docNodeId: "doc", visibility: "household" as const, sourceTitle: "Brev om tur", now: new Date("2026-10-01T10:00:00Z") };

function apply(known0: KnownNode[], edges0: Set<string>, changes: ChangeInput[]) {
  const k = [...known0], e = new Set(edges0);
  for (const c of changes) {
    if (c.op === "addNode") k.push({ id: c.nodeId!, type: c.type, label: c.label, aliases: c.aliases ?? [], startAt: c.startAt ?? null });
    if (c.op === "addEdge") e.add(edgeKey(c.fromId, c.relation, c.toId));
  }
  return { k, e };
}

describe("buildProposalOps", () => {
  it("proposes new nodes, mentions, facts and reminders, each with a receipt", () => {
    const plan = buildProposalOps({ ...base, groups: [{ ex, chunks: [chunk] }], known, existingEdges: new Set(), mint, remindFor: new Map([["emma", "Emma"]]) });
    const ops = plan.changes.map((c) => c.op);
    expect(plan.counts).toMatchObject({ people: 1, events: 1, other: 1, connections: 2, reminders: 1 });
    expect(ops.filter((o) => o === "addNode")).toHaveLength(3); // Bo, the trip, the Zoo — Emma is known
    const fact = plan.changes.find((c) => c.op === "addEdge" && c.relation === "involves") as Extract<ChangeInput, { op: "addEdge" }>;
    expect(fact.toId).toBe("emma");
    expect(fact.receipt).toMatchObject({ sourceId: "s1", chunkId: "c1", locator: { page: 1 }, quote: "Emma skal på tur til Zoo" });
    for (const c of plan.changes) expect(c.receipt?.sourceId).toBe("s1");
    expect(plan.changes.find((c) => c.op === "addReminder")).toMatchObject({ aboutNodeId: "emma", title: "Emma: Tur til Zoo" });
    expect(ex.documentDate?.at.toISOString().slice(0, 10)).toBe("2026-10-01");
  });

  it("proposes nothing new when the graph already holds what the document says (idempotent)", () => {
    const first = buildProposalOps({ ...base, groups: [{ ex, chunks: [chunk] }], known, existingEdges: new Set(), mint });
    const { k, e } = apply(known, new Set(), first.changes);
    const again = buildProposalOps({ ...base, groups: [{ ex, chunks: [chunk] }], known: k, existingEdges: e, mint });
    expect(again.changes).toEqual([]);
  });

  it("treats an event with the same name on another day as a new event", () => {
    const k: KnownNode[] = [...known, { id: "old-trip", type: "event", label: "Tur til Zoo", aliases: [], startAt: "2025-05-01T08:00:00Z" }];
    const plan = buildProposalOps({ ...base, groups: [{ ex, chunks: [chunk] }], known: k, existingEdges: new Set(), mint });
    expect(plan.changes.some((c) => c.op === "addNode" && c.type === "event")).toBe(true);
  });
});

describe("correspondentOps", () => {
  it("proposes unknown correspondents once, skipping known emails, names, pending ones and no-reply", () => {
    const ops = correspondentOps({
      participants: [
        { name: "Bo Hansen", email: "bo@skole.dk", role: "from" },
        { name: "Emma Jensen", email: "emma@x.dk", role: "to" },
        { name: null, email: "anna@x.dk", role: "to" },
        { name: "Pia", email: "pia@x.dk", role: "cc" },
        { name: null, email: "noreply@aula.dk", role: "from" },
        { name: "Bo", email: "BO@skole.dk", role: "cc" },
      ],
      known, knownEmails: new Set(["anna@x.dk"]), pendingEmails: new Set(["pia@x.dk"]), sourceId: "s1", header: "From: Bo", mint,
    });
    expect(ops.map((o) => (o.op === "addNode" ? `${o.label}|${o.props?.email}` : ""))).toEqual(["Bo Hansen|bo@skole.dk"]);
  });
});

it("describes counts in plain words", () => {
  expect(describeCounts({ people: 2, events: 1, connections: 3 })).toBe("2 people, 1 date and 3 connections");
  expect(describeCounts({})).toBe("nothing new");
});
