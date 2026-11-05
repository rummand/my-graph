import { describe, expect, it } from "vitest";
import { buildMatcher } from "./matcher";
import { mergeLive, newRef, relocateResult, type SentenceResult } from "./merge";
import { splitSentences } from "./sentences";

const matcher = buildMatcher([{ id: "11111111-1111-4111-8111-111111111111", label: "Emma", type: "person" }]);
const EMMA = "n:11111111-1111-4111-8111-111111111111";

function result(key: string, text: string, ents: { label: string; type?: string; existing?: boolean; nodeId?: string; kind?: string; newKind?: boolean }[], facts: [string, string, string][] = []): SentenceResult {
  return {
    key, text,
    entities: ents.map((e) => {
      const at = text.indexOf(e.label);
      return { ref: e.nodeId ? `n:${e.nodeId}` : newRef(e.label), label: e.label, surface: e.label, type: (e.type ?? "person") as "person", kindKey: e.kind ?? null, kindLabel: e.kind ?? null, newKind: !!e.newKind, nodeId: e.nodeId ?? null, existing: !!e.existing, at, len: e.label.length };
    }),
    facts: facts.map(([from, rel, to], i) => ({ ref: `f${i}`, from, to, relationKey: rel, relationLabel: rel.replace(/_/g, " "), newRelation: false })),
    kinds: [], relations: facts.map(([, rel]) => ({ key: rel, label: rel, inverseLabel: rel, fromTypes: [], toTypes: [], isNew: false })),
  };
}

describe("merging the tiers", () => {
  const text = "Emma met Peter Andersen. Peter works at Novo Nordisk.";
  const ss = splitSentences(text);
  const r1 = result(ss[0].key, ss[0].text, [{ label: "Peter Andersen" }], [[EMMA, "knows", newRef("Peter Andersen")]]);
  const r2 = result(ss[1].key, ss[1].text, [{ label: "Novo Nordisk", type: "organization", kind: "Company", newKind: true }], [["you", "knows", newRef("Novo Nordisk")]]);

  it("puts graph names, model things and facts together with stable refs", () => {
    const links = matcher.match(text);
    const { plan, spans } = mergeLive({ text, sentences: ss, results: [r1, r2], links });
    expect(plan.entities.map((e) => e.ref)).toEqual([EMMA, newRef("Peter Andersen"), newRef("Novo Nordisk")]);
    expect(spans.filter((s) => s.tone !== "detail").map((s) => `${s.tone}:${s.text}`)).toEqual(["existing:Emma", "new:Peter Andersen", "newKind:Novo Nordisk"]);
    expect(plan.facts.map((f) => `${f.from}>${f.to}`)).toEqual([`${EMMA}>${newRef("Peter Andersen")}`, `you>${newRef("Novo Nordisk")}`]);
  });

  it("gives the same answer whatever order the sentences' answers arrive in", () => {
    const links = matcher.match(text);
    const a = mergeLive({ text, sentences: ss, results: [r1, r2], links });
    const onlySecond = mergeLive({ text, sentences: ss, results: [null, r2], links });
    const both = mergeLive({ text, sentences: ss, results: [r1, r2], links });
    expect(both).toEqual(a);
    expect(onlySecond.plan.entities.map((e) => e.label)).toEqual(["Emma", "Novo Nordisk"]);
  });

  it("follows a sentence when text before it changes", () => {
    const t2 = "Yesterday, " + text;
    const ss2 = splitSentences(t2);
    expect(ss2[1].key).toBe(ss[1].key);
    const { spans } = mergeLive({ text: t2, sentences: ss2, results: [null, r2], links: [] });
    const novo = spans.find((s) => s.text === "Novo Nordisk")!;
    expect(t2.slice(novo.start, novo.end)).toBe("Novo Nordisk");
  });

  it("graph names win over overlapping model things; facts to a dropped thing go", () => {
    const t = "Emma Hansen called.";
    const s = splitSentences(t);
    const r = result(s[0].key, s[0].text, [{ label: "Emma Hansen" }], [["you", "knows", newRef("Emma Hansen")]]);
    const { plan } = mergeLive({ text: t, sentences: s, results: [r], links: matcher.match(t) });
    expect(plan.entities.map((e) => e.label)).toEqual(["Emma"]);
    expect(plan.facts).toEqual([]);
  });

  it("read-only graphs get links only", () => {
    const { plan, spans } = mergeLive({ text, sentences: ss, results: [r1, r2], links: matcher.match(text), linksOnly: true, details: [{ start: 0, end: 4, text: "Emma", kind: "date" }] });
    expect(plan.entities.map((e) => e.ref)).toEqual([EMMA]);
    expect(spans.map((s) => s.tone)).toEqual(["existing"]);
  });

  it("@mentions come first and created things are located", () => {
    const t = "@Emma and @Garden Club";
    const { plan, spans } = mergeLive({ text: t, sentences: splitSentences(t), results: [null], links: matcher.match(t), mentions: [{ start: 0, end: 5, nodeId: "11111111-1111-4111-8111-111111111111", label: "Emma", type: "person" }], created: ["Garden Club"] });
    expect(spans.map((s) => `${s.tone}:${s.text}`)).toEqual(["mention:@Emma", "new:@Garden Club"]);
    expect(plan.entities.map((e) => e.label)).toEqual(["Emma", "Garden Club"]);
  });

  it("merges the whole-text facts pass, without duplicates", () => {
    const links = matcher.match(text);
    const facts = { facts: [{ ref: "f1", from: newRef("Peter Andersen"), to: newRef("Novo Nordisk"), relationKey: "works_at", relationLabel: "works at", newRelation: true }, r2.facts[0]], relations: [{ key: "works_at", label: "works at", inverseLabel: "employs", fromTypes: [], toTypes: [], isNew: true }] };
    const { plan } = mergeLive({ text, sentences: ss, results: [r1, r2], links, facts });
    expect(plan.facts.map((f) => f.relationKey)).toEqual(["knows", "knows", "works_at"]);
    expect(plan.relations.map((r) => r.key).sort()).toEqual(["knows", "works_at"]);
  });
});

describe("relocating a result while its sentence is edited", () => {
  it("keeps things whose words are still there and moves them", () => {
    const r = result("k", "Emma met Peter Andersen", [{ label: "Peter Andersen" }], [["you", "knows", newRef("Peter Andersen")]]);
    const moved = relocateResult(r, "Emma happily met Peter Andersen at noon");
    expect(moved.entities[0].at).toBe("Emma happily met ".length);
    expect(moved.facts.length).toBe(1);
  });
  it("drops things whose words are gone, and their facts", () => {
    const r = result("k", "Emma met Peter Andersen", [{ label: "Peter Andersen" }], [["you", "knows", newRef("Peter Andersen")]]);
    const moved = relocateResult(r, "Emma met Pet");
    expect(moved.entities).toEqual([]);
    expect(moved.facts).toEqual([]);
  });
});
