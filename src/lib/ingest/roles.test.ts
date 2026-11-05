import { describe, expect, it } from "vitest";
import type { ChangeInput } from "@/lib/changes";
import { parseExtraction } from "./extraction";
import { buildProposalOps, describeCounts, edgeKey, type KnownNode } from "./proposals";
import { dropGenericPeople } from "./recording";
import { roleOpsFromPeople } from "./roles";

type Edge = Extract<ChangeInput, { op: "addEdge" }>;
const edgesOf = (cs: ChangeInput[]) => cs.filter((c): c is Edge => c.op === "addEdge");
const chunk = { id: "c1", idx: 0, text: "Karen Hansen er klasselærer for 3.B på Ny Skole siden august 2024. Lægen ringer i morgen.", locator: { page: 1 } };
const base = { sourceId: "s1", docNodeId: "doc", visibility: "household" as const, sourceTitle: "Brev", now: new Date("2026-10-01T10:00:00Z") };

describe("roles in what a document proposes", () => {
  it("reads roles from the model's answer, dropping ones with nobody named", () => {
    const ex = parseExtraction({ entities: [], facts: [], roles: [
      { person: "Karen Hansen", role: "klasselærer", context: "3.B", from: "2024-08-01", quote: "klasselærer for 3.B" },
      { person: null, role: "læge" },
      { role: "x" },
      { person: "Bo", role: "coach", from: "2025-01-01", to: "2024-01-01" },
    ] });
    expect(ex.roles?.map((r) => [r.person, r.role, r.context ?? null])).toEqual([["Karen Hansen", "klasselærer", "3.B"], ["Bo", "coach", null]]);
    expect(ex.roles?.[1].to).toBeUndefined(); // an end before the start is dropped
    expect(ex.dropped).toBe(2);
  });

  it("never proposes a person for an unnamed role, and proposes the role held in its context", () => {
    let n = 0;
    const ex = parseExtraction({
      entities: [
        { type: "person", label: "Karen Hansen" }, { type: "person", label: "Lægen" }, { type: "organization", label: "3.B" }, { type: "person", label: "Speaker 2" },
      ],
      facts: [{ from: "Lægen", relation: "knows", to: "Karen Hansen", confidence: 0.9 }],
      roles: [
        { person: "Karen Hansen", role: "klasselærer", context: "3.B", from: "2024-08-01", quote: "Karen Hansen er klasselærer for 3.B", confidence: 0.95 },
        { person: "Lægen", role: "læge" },
        { person: "Karen Hansen", role: "plumber-ish thing" },
      ],
    });
    const plan = buildProposalOps({ ...base, groups: [{ ex, chunks: [chunk] }], known: [], existingEdges: new Set(), mint: () => `n${++n}` });
    const people = plan.changes.filter((c) => c.op === "addNode" && c.type === "person").map((c) => (c as { label: string }).label);
    expect(people).toEqual(["Karen Hansen"]);
    const karen = (plan.changes.find((c) => c.op === "addNode" && c.label === "Karen Hansen") as { nodeId: string }).nodeId;
    const klass = (plan.changes.find((c) => c.op === "addNode" && c.label === "3.B") as { nodeId: string }).nodeId;
    const roles = edgesOf(plan.changes).filter((e) => e.relation.startsWith("role:"));
    expect(roles).toHaveLength(1);
    expect(roles[0]).toMatchObject({ fromId: karen, toId: klass, relation: "role:class_teacher", status: "confirmed", validFrom: "2024-08-01T00:00:00.000Z" });
    expect(roles[0].receipt?.quote).toContain("klasselærer");
    expect(edgesOf(plan.changes).some((e) => e.relation === "knows")).toBe(false);
    expect(plan.counts.roles).toBe(1);
    expect(describeCounts(plan.counts)).toContain("1 role");
    // Idempotent: the role already held is not proposed again.
    const again = buildProposalOps({ ...base, groups: [{ ex, chunks: [chunk] }], known: [{ id: karen, type: "person", label: "Karen Hansen", aliases: [] }, { id: klass, type: "organization", label: "3.B", aliases: [] }],
      existingEdges: new Set(edgesOf(plan.changes).map((e) => edgeKey(e.fromId, e.relation, e.toId))), mint: () => `m${++n}` });
    expect(edgesOf(again.changes).filter((e) => e.relation.startsWith("role:"))).toEqual([]);
  });

  it("a role with no known context points back at the person", () => {
    const known: KnownNode[] = [{ id: "lars", type: "person", label: "Lars Holm", aliases: [] }];
    const ex = parseExtraction({ entities: [], facts: [], roles: [{ person: "Lars Holm", role: "our landlord", context: "somewhere unknown" }] });
    const plan = buildProposalOps({ ...base, groups: [{ ex, chunks: [chunk] }], known, existingEdges: new Set(), mint: () => "x" });
    expect(edgesOf(plan.changes).map((e) => [e.fromId, e.relation, e.toId])).toEqual([["lars", "role:landlord", "lars"]]);
  });

  it("a new person called by a role word holds that role (unconfirmed), never as a kind", () => {
    const changes: ChangeInput[] = [
      { op: "addNode", nodeId: "p1", type: "person", label: "Dr. Mette Lund" },
      { op: "addNode", nodeId: "p2", type: "person", label: "Sofie", summary: "Pædagog i Solsikken" },
      { op: "addNode", nodeId: "o1", type: "place", label: "Solsikken" },
      { op: "addEdge", fromId: "p2", toId: "o1", relation: "located_at" },
      { op: "addNode", nodeId: "p3", type: "person", label: "Mormor" },
      { op: "addNode", nodeId: "p4", type: "person", label: "Bo", summary: "Teacher" },
      { op: "addEdge", fromId: "p4", toId: "p4", relation: "role:class_teacher" },
    ];
    const out = roleOpsFromPeople(changes, new Set([edgeKey("p1", "role:dentist", "p1")]));
    expect(out.map((c) => [(c as Edge).fromId, (c as Edge).relation, (c as Edge).toId, (c as Edge).status])).toEqual([
      ["p1", "role:doctor", "p1", "unconfirmed"], ["p2", "role:pedagogue", "o1", "unconfirmed"],
    ]);
  });

  it("a meeting's role-only speakers are tidied away with what was said about them", () => {
    const changes: ChangeInput[] = [
      { op: "addNode", nodeId: "a", type: "person", label: "the teacher" },
      { op: "addNode", nodeId: "b", type: "person", label: "Speaker 4" },
      { op: "addNode", nodeId: "c", type: "person", label: "Ida" },
      { op: "addEdge", fromId: "a", toId: "c", relation: "knows" },
    ];
    expect(dropGenericPeople(changes)).toBe(2);
    expect(changes.map((c) => c.op === "addNode" ? c.label : c.op)).toEqual(["Ida"]);
  });
});
