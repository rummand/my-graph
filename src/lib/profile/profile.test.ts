import { describe, expect, it } from "vitest";
import { EMPTY_PROFILE_DOC, planSave, profileDocNodeIds, profileDocText, sanitizeProfileDoc, sameDoc, wordDelta, ProfileDocError } from "./doc";
import { factOps, FactError, kindKeyOf, presetFor } from "./presets";
import { factBlocks, isPetKind, opMentions, provChips, sectionForFact, sectionsFor, suggestionBlocks, type EndLike, type MetaLike } from "./sections";
import { insightsAllowed, ownConversation } from "./insights-gate";
import { evidenceHash, insightsMessages, parseInsights, prepareEvidence } from "./insights-pure";
import type { Evidence } from "./types";

const ANNA = "11111111-1111-4111-8111-111111111111";
const FIDO = "22222222-2222-4222-8222-222222222222";
const IDA = "33333333-3333-4333-8333-333333333333";
const SCHOOL = "44444444-4444-4444-8444-444444444444";
const ACME = "55555555-5555-4555-8555-555555555555";
const VOLVO = "66666666-6666-4666-8666-666666666666";

const RELS: Record<string, { key: string; category: string; label: string; inverseLabel: string }> = {
  owns: { key: "owns", category: "other", label: "owns", inverseLabel: "owned by" },
  parent_of: { key: "parent_of", category: "family", label: "parent of", inverseLabel: "child of" },
  attends: { key: "attends", category: "school", label: "attends", inverseLabel: "attended by" },
  member_of: { key: "member_of", category: "work", label: "member of", inverseLabel: "has member" },
  friend_of: { key: "friend_of", category: "social", label: "friend of", inverseLabel: "friend of" },
  treated_by: { key: "treated_by", category: "care", label: "treated by", inverseLabel: "treats" },
  interested_in: { key: "interested_in", category: "social", label: "interested in", inverseLabel: "interest of" },
};
const KINDS: Record<string, string> = { "thing:dog": "Dog", "thing:pet": "Pet", "thing:car": "Car", "place:school": "School", "person:child": "Child" };
const meta: MetaLike = {
  relation: (k) => RELS[k],
  relationLabel: (k, d) => (RELS[k] ? (d === "out" ? RELS[k].label : RELS[k].inverseLabel) : k),
  kindLabel: (t, k) => (k ? KINDS[`${t}:${k}`] ?? null : null),
};

describe("sections per kind", () => {
  it("gives a person the family-life sections, with Notes last", () => {
    const keys = sectionsFor("person", "partner").filter((s) => s.core).map((s) => s.key);
    expect(keys).toEqual(["overview", "family", "home", "pets", "work", "interests", "dates", "notes"]);
  });
  it("puts School first for a child, Work optional", () => {
    const s = sectionsFor("person", "child");
    expect(s.find((x) => x.key === "school")?.core).toBe(true);
    expect(s.find((x) => x.key === "work")?.core).toBe(false);
  });
  it("gives an organisation People and Projects, and a project its dependencies and milestones", () => {
    expect(sectionsFor("organization").filter((s) => s.core).map((s) => s.key)).toEqual(["overview", "people", "projects", "notes"]);
    const p = sectionsFor("project").map((s) => s.key);
    expect(p).toContain("dependencies");
    expect(p).toContain("events");
  });
  it("falls back to Overview, Connections and Notes for anything else", () => {
    expect(sectionsFor("topic").filter((s) => s.core).map((s) => s.key)).toEqual(["overview", "connections", "notes"]);
  });
  it("offers the presets that fit each section", () => {
    expect(sectionsFor("person").find((s) => s.key === "pets")?.presets).toEqual(["pet"]);
    expect(sectionsFor("person").find((s) => s.key === "family")?.presets).toContain("child");
  });
});

describe("fact-to-block mapping", () => {
  const person: EndLike = { id: ANNA, type: "person", kind: "partner" };
  const available = sectionsFor("person", "partner").map((s) => s.key);
  const nb = new Map<string, EndLike>([
    [FIDO, { id: FIDO, type: "thing", kind: "dog", label: "Fido" }],
    [IDA, { id: IDA, type: "person", kind: "child", label: "Ida" }],
    [SCHOOL, { id: SCHOOL, type: "place", kind: "school", label: "Nørre Skole" }],
    [ACME, { id: ACME, type: "organization", kind: null, label: "Acme" }],
    [VOLVO, { id: VOLVO, type: "thing", kind: "car", label: "Volvo" }],
  ]);
  const edges = [
    { id: "e1", fromId: ANNA, toId: FIDO, relation: "owns", status: "confirmed" as const, confidence: 1 },
    { id: "e2", fromId: ANNA, toId: IDA, relation: "parent_of", status: "confirmed" as const, confidence: 1 },
    { id: "e3", fromId: ANNA, toId: ACME, relation: "member_of", status: "inferred" as const, confidence: 0.6 },
    { id: "e4", fromId: ANNA, toId: VOLVO, relation: "owns", status: "confirmed" as const, confidence: 1 },
    { id: "e5", fromId: ANNA, toId: SCHOOL, relation: "attends", status: "rejected" as const, confidence: 1 },
  ];
  const prov = { e1: [{ sourceId: "s1", sourceTitle: "Vet bill", quote: "Fido, golden retriever", agentType: "model" as const, confidence: 0.9, createdAt: "2026-10-01T10:00:00Z", locator: { page: 2 } }] };
  const blocks = factBlocks(person, edges, nb, meta, prov, available);

  it("reads owning a dog as 'Has a dog: Fido' under Pets", () => {
    const b = blocks.find((x) => x.edgeId === "e1")!;
    expect(b.section).toBe("pets");
    expect(b.phrase).toEqual({ kind: "has", what: "dog" });
    expect(b.other).toMatchObject({ label: "Fido", href: `/node/${FIDO}` });
  });
  it("carries a provenance chip for each fact", () => {
    const b = blocks.find((x) => x.edgeId === "e1")!;
    expect(b.provenance[0]).toMatchObject({ title: "Vet bill", href: "/library/s1", detail: "p2", confidence: 0.9, quote: "Fido, golden retriever" });
  });
  it("puts children in Family, cars in Home, workplaces in Work", () => {
    expect(blocks.find((x) => x.edgeId === "e2")).toMatchObject({ section: "family", phrase: { kind: "rel", label: "parent of" } });
    expect(blocks.find((x) => x.edgeId === "e4")?.section).toBe("home");
    expect(blocks.find((x) => x.edgeId === "e3")?.section).toBe("work");
  });
  it("leaves rejected facts out and lists facts that need a decision first", () => {
    expect(blocks.some((x) => x.edgeId === "e5")).toBe(false);
    expect(blocks[0].status).toBe("inferred");
  });
  it("reads a fact from the other side with the inverse label", () => {
    const ida: EndLike = { id: IDA, type: "person", kind: "child" };
    const b = factBlocks(ida, [edges[1]], new Map([[ANNA, { id: ANNA, type: "person", kind: "partner", label: "Anna" }]]), meta, {}, sectionsFor("person", "child").map((s) => s.key));
    expect(b[0]).toMatchObject({ direction: "in", section: "family", phrase: { kind: "rel", label: "child of" }, other: { href: `/people/${ANNA}` } });
  });
  it("sends school to School for a child and to Work when there is no School section", () => {
    const kid = sectionsFor("person", "child").map((s) => s.key);
    const school = { id: SCHOOL, type: "place", kind: "school" };
    expect(sectionForFact({ id: IDA, type: "person" }, "attends", RELS.attends, school, kid)).toBe("school");
    expect(sectionForFact({ id: ANNA, type: "person" }, "attends", RELS.attends, school, ["overview", "work", "notes"])).toBe("work");
  });
  it("files facts on an organisation by what is at the other end", () => {
    const keys = sectionsFor("organization").map((s) => s.key);
    expect(sectionForFact({ id: ACME, type: "organization" }, "member_of", RELS.member_of, { id: ANNA, type: "person" }, keys)).toBe("people");
    expect(sectionForFact({ id: ACME, type: "organization" }, "x", undefined, { id: "p", type: "project" }, keys)).toBe("projects");
  });
  it("recognises pets in English and Danish", () => {
    expect(isPetKind("dog")).toBe(true);
    expect(isPetKind("kat", "Kat")).toBe(true);
    expect(isPetKind("car")).toBe(false);
  });
  it("words a hand-added fact without a source as 'Added by hand'", () => {
    expect(provChips([{ sourceId: null, sourceTitle: null, quote: null, agentType: "user", confidence: 1, createdAt: new Date("2026-01-02T00:00:00Z") }])[0])
      .toMatchObject({ code: "by_hand", detail: "2026-01-02" });
    expect(provChips([{ sourceId: "x", sourceTitle: null, quote: null, agentType: "model", confidence: 1, createdAt: "2026-01-02" }])[0].code).toBe("hidden_source");
  });
});

describe("pending suggestions on a profile", () => {
  const subject: EndLike = { id: ANNA, type: "person", kind: "partner" };
  const keys = sectionsFor("person", "partner").map((s) => s.key);
  const set = {
    id: "cs1", title: "From the vet letter", origin: "ingest", status: "draft", createdAt: "2026-10-01T00:00:00Z",
    changes: [
      { id: "c1", op: "addKind", summary: "New kind Dog", nodeId: null, included: true, payload: { nodeType: "thing", key: "dog" }, receipt: {} },
      { id: "c2", op: "addNode", summary: "Add Fido", nodeId: FIDO, included: true, payload: { type: "thing", kind: "dog", label: "Fido" }, receipt: {} },
      { id: "c3", op: "addEdge", summary: "Anna owns Fido", nodeId: null, included: true, payload: { fromId: ANNA, toId: FIDO, relation: "owns" }, receipt: { quote: "Anna's dog Fido", sourceId: "s1" } },
      { id: "c4", op: "addNode", summary: "Add Karl", nodeId: "k", included: true, payload: { type: "person", label: "Karl" }, receipt: {} },
    ],
  };
  it("shows an agent's fact in the right section, bringing the new thing and kind it needs", () => {
    const s = suggestionBlocks(subject, [set], meta, keys);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ section: "pets", changeId: "c3", otherCount: 1, receipt: { quote: "Anna's dog Fido", sourceId: "s1" } });
    expect(s[0].changeIds.sort()).toEqual(["c1", "c2", "c3"]);
  });
  it("ignores delivered sets and ops about other nodes", () => {
    expect(suggestionBlocks(subject, [{ ...set, status: "delivered" }], meta, keys)).toEqual([]);
    expect(opMentions(set.changes[3], ANNA)).toBe(false);
  });
});

describe("facts written on a profile", () => {
  const model = { hasRelation: (k: string) => k !== "owns", hasKind: (t: string, k: string) => !(t === "thing" && k === "dog") };
  let n = 0;
  const mint = () => `00000000-0000-4000-8000-00000000000${++n}`;
  it("adds the relation type and kind the family graph lacks, then the pet and the fact", () => {
    const p = presetFor("pet", "person")!;
    const r = factOps(ANNA, { relation: p.relation, direction: p.direction, other: { label: "Fido", type: "thing", kind: kindKeyOf("Dog"), kindLabel: "Dog" }, relationDef: p.relationDef, kindDef: p.kindDef }, model, { mint, receipt: {} });
    expect(r.ops.map((o) => o.op)).toEqual(["addRelationType", "addKind", "addNode", "addEdge"]);
    expect(r.ops[1]).toMatchObject({ key: "dog", label: "Dog", nodeType: "thing" });
    expect(r.ops[3]).toMatchObject({ fromId: ANNA, toId: r.otherId, relation: "owns", status: "confirmed" });
  });
  it("links to an existing node and turns 'in' facts around", () => {
    const r = factOps(ANNA, { relation: "parent_of", direction: "in", other: { id: IDA } }, model, { mint, receipt: {} });
    expect(r.ops).toHaveLength(1);
    expect(r.ops[0]).toMatchObject({ op: "addEdge", fromId: IDA, toId: ANNA });
  });
  it("refuses an unknown relation without a definition, and a fact to itself", () => {
    expect(() => factOps(ANNA, { relation: "owns", direction: "out", other: { id: FIDO } }, model, { mint, receipt: {} })).toThrow(FactError);
    expect(() => factOps(ANNA, { relation: "parent_of", direction: "out", other: { id: ANNA } }, model, { mint, receipt: {} })).toThrow(FactError);
  });
  it("makes kind keys from Danish words", () => {
    expect(kindKeyOf("Kæledyr")).toBe("kaeledyr");
    expect(kindKeyOf("Golden retriever")).toBe("golden_retriever");
  });
});

describe("profile doc versioning", () => {
  const doc = (text: string) => ({ type: "doc" as const, content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
  it("starts at version 1 and never stores an empty first save", () => {
    expect(planSave(null, doc("Has two kids, Ida and Karl"), null)).toEqual({ kind: "save", version: 1 });
    expect(planSave(null, EMPTY_PROFILE_DOC, null).kind).toBe("unchanged");
  });
  it("bumps the version on change and keeps it on the same text", () => {
    const cur = { version: 3, doc: doc("a") };
    expect(planSave(cur, doc("b"), 3)).toEqual({ kind: "save", version: 4 });
    expect(planSave(cur, doc("a"), 1)).toEqual({ kind: "unchanged", version: 3 });
  });
  it("refuses a save based on an older version (someone else saved)", () => {
    expect(planSave({ version: 5, doc: doc("a") }, doc("b"), 4)).toEqual({ kind: "conflict", version: 5 });
  });
  it("compares docs whatever order attributes were written in", () => {
    expect(sameDoc({ type: "doc", attrs: { a: 1, b: 2 } }, { type: "doc", attrs: { b: 2, a: 1 } })).toBe(true);
  });
  it("keeps toggles, tables, images and fact chips, and drops what it doesn't know", () => {
    const raw = {
      type: "doc", content: [
        { type: "toggle", attrs: { summary: "Allergies", open: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "Nuts" }] }] },
        { type: "table", content: [{ type: "tableRow", content: [{ type: "tableHeader", content: [{ type: "paragraph" }] }] }] },
        { type: "libraryImage", attrs: { sourceId: FIDO.toUpperCase(), alt: "Fido" } },
        { type: "libraryImage", attrs: { sourceId: "javascript:alert(1)" } },
        { type: "paragraph", content: [{ type: "factRef", attrs: { otherId: FIDO, otherLabel: "Fido", otherType: "thing", phrase: "Has a dog" } }, { type: "mention", attrs: { id: IDA, label: "Ida" } }] },
        { type: "script", content: [] },
        { type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }] },
      ],
    };
    const d = sanitizeProfileDoc(raw);
    expect(d.content!.map((n) => n.type)).toEqual(["toggle", "table", "libraryImage", "paragraph", "paragraph"]);
    expect(d.content![2].attrs).toEqual({ sourceId: FIDO, alt: "Fido" });
    expect(d.content![4].content![0].marks).toBeUndefined();
    expect(profileDocNodeIds(d)).toEqual([FIDO, IDA]);
    expect(profileDocText(d)).toContain("Allergies");
    expect(profileDocText(d)).toContain("Has a dog Fido");
  });
  it("refuses something that isn't a doc", () => {
    expect(() => sanitizeProfileDoc({ type: "paragraph" })).toThrow(ProfileDocError);
  });
  it("counts words changed between versions", () => {
    expect(wordDelta("has a dog", "has a dog and a cat")).toEqual({ added: 3, removed: 0 });
  });
});

describe("insights", () => {
  it("are only for people, for members with the feature who can read them", () => {
    expect(insightsAllowed({ featureOn: true, role: "parent", nodeType: "person", canRead: true })).toBe(true);
    expect(insightsAllowed({ featureOn: false, role: "parent", nodeType: "person", canRead: true })).toBe(false);
    expect(insightsAllowed({ featureOn: true, role: "guest", nodeType: "person", canRead: true })).toBe(false);
    expect(insightsAllowed({ featureOn: true, role: "parent", nodeType: "place", canRead: true })).toBe(false);
    expect(insightsAllowed({ featureOn: true, role: "parent", nodeType: "person", canRead: false })).toBe(false);
  });
  it("never count someone else's conversation as evidence", () => {
    expect(ownConversation("me", "me")).toBe(true);
    expect(ownConversation("me", "sara")).toBe(false);
  });

  const evidence: Evidence[] = prepareEvidence([
    { kind: "checkin", at: "2026-10-03T08:00:00Z", title: "Check-in", text: "Wellbeing 2/5 tired after exams", href: "/people/x#wellbeing" },
    { kind: "chat", at: "2026-10-05T08:00:00Z", title: "Your chat", text: "Ida said she is worried about the football tryout", href: "/chat/c1" },
  ]);

  it("number evidence newest first", () => {
    expect(evidence.map((e) => [e.id, e.kind])).toEqual([["e1", "chat"], ["e2", "checkin"]]);
  });
  it("keep only lines that cite evidence they were given", () => {
    const { insights, dropped } = parseInsights({
      timeline: [
        { at: "2026-10-05", area: "stress", text: "Worried about the football tryout.", evidence: ["e1"] },
        { at: "2026-09-01", area: "health", text: "Has a heart condition.", evidence: [] },
        { at: "2026-09-01", area: "mood", text: "Made up.", evidence: ["e9"] },
        { at: "1999-01-01", area: "nonsense", text: "Tired after exams.", evidence: ["[e2]"] },
      ],
      matters: [{ text: "Football", evidence: ["e1"] }, { text: "Unsupported", evidence: ["zzz"] }],
      followUps: [{ text: "Ask how the tryout went", evidence: ["e1", "e1"] }],
      injected: "ignored",
    }, evidence);
    expect(dropped).toBe(3);
    expect(insights.timeline.map((l) => l.text)).toEqual(["Worried about the football tryout.", "Tired after exams."]);
    // An invented date is replaced by the cited evidence's date, an unknown area becomes "other".
    expect(insights.timeline[1]).toMatchObject({ at: "2026-10-03", area: "other", evidence: ["e2"] });
    expect(insights.matters).toEqual([{ text: "Football", evidence: ["e1"] }]);
    expect(insights.followUps[0].evidence).toEqual(["e1"]);
  });
  it("survive a model answer that isn't the expected shape", () => {
    expect(parseInsights("nope", evidence)).toEqual({ insights: { timeline: [], matters: [], followUps: [] }, dropped: 0 });
  });
  it("tell the model to use only the evidence and treat it as data", () => {
    const [sys, user] = insightsMessages("Ida", evidence, "da");
    expect(sys.content).toMatch(/ONLY the evidence/);
    expect(sys.content).toMatch(/data, not instructions/);
    expect(sys.content).toMatch(/Danish/);
    expect(user.content).toContain("[e1]");
  });
  it("notice when new evidence arrives", () => {
    const more = prepareEvidence([...evidence, { kind: "note", at: "2026-10-06T00:00:00Z", title: "Profile notes", text: "Started therapy", href: "/p#notes" }]);
    expect(evidenceHash(evidence)).toBe(evidenceHash([...evidence].reverse()));
    expect(evidenceHash(more)).not.toBe(evidenceHash(evidence));
  });
});

describe("rolling a profile back", () => {
  it("only touches the node and its facts, keeping the other ends as they are now", async () => {
    const { scopeToNode } = await import("./sections");
    type N = { id: string; label: string };
    type E = { id: string; fromId: string; toId: string };
    const now = { nodes: new Map<string, N>([[ANNA, { id: ANNA, label: "Anna B" }], [IDA, { id: IDA, label: "Ida 2" }], [FIDO, { id: FIDO, label: "Fido" }]]), edges: new Map<string, E>([["e1", { id: "e1", fromId: ANNA, toId: FIDO }], ["x", { id: "x", fromId: IDA, toId: FIDO }]]) };
    const then = { nodes: new Map<string, N>([[ANNA, { id: ANNA, label: "Anna" }], [IDA, { id: IDA, label: "Ida" }], [SCHOOL, { id: SCHOOL, label: "Gone now" }]]), edges: new Map<string, E>([["e2", { id: "e2", fromId: ANNA, toId: IDA }], ["e3", { id: "e3", fromId: ANNA, toId: SCHOOL }]]) };
    const s = scopeToNode(now, then, ANNA);
    expect([...s.now.edges.keys()]).toEqual(["e1"]);
    expect([...s.then.edges.keys()].sort()).toEqual(["e2", "e3"]);
    expect(s.then.nodes.get(ANNA)?.label).toBe("Anna");
    // Ida is kept as she is now (restoring Anna never renames Ida); the school, gone now, comes back from then.
    expect(s.then.nodes.get(IDA)?.label).toBe("Ida 2");
    expect(s.then.nodes.get(SCHOOL)?.label).toBe("Gone now");
  });
});
