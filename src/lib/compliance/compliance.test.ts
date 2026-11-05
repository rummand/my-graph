import { describe, expect, it } from "vitest";
import {
  acceptProblem, countFindings, fingerprintOf, nothingClose, paragraphKey, parseVerdicts, pickCorpora, reconcile, ruleSetVersion, scopeApplies, selectRules, shiftFindings, TtlCache,
  type FreshFinding,
} from "./pure";
import { artifactText, blockAt, replaceInBlock } from "./blocks";
import { locate, splitParagraphs } from "./text";

describe("scope selection", () => {
  it("covers everything when unlimited", () => {
    expect(scopeApplies({ all: true }, { targetType: "message" })).toBe(true);
    expect(scopeApplies({}, { targetType: "wiki" })).toBe(true);
    expect(scopeApplies(null, { targetType: "wiki" })).toBe(true);
  });
  it("limits by target type", () => {
    expect(scopeApplies({ targetTypes: ["wiki", "artifact"] }, { targetType: "wiki" })).toBe(true);
    expect(scopeApplies({ targetTypes: ["wiki"] }, { targetType: "message" })).toBe(false);
  });
  it("a wiki section limits wiki pages to that section, and on its own means wiki only", () => {
    const s = { wikiSlugs: ["architecture"] };
    expect(scopeApplies(s, { targetType: "wiki", wikiSlug: "architecture-data-flows" })).toBe(true);
    expect(scopeApplies(s, { targetType: "wiki", wikiSlug: "holiday-plans" })).toBe(false);
    expect(scopeApplies(s, { targetType: "artifact", artifactKind: "report" })).toBe(false);
    expect(scopeApplies({ ...s, targetTypes: ["wiki", "message"] }, { targetType: "message" })).toBe(true);
  });
  it("limits documents by kind, nodes by kind, anything by tags", () => {
    expect(scopeApplies({ artifactKinds: ["one_pager"] }, { targetType: "artifact", artifactKind: "one_pager" })).toBe(true);
    expect(scopeApplies({ artifactKinds: ["one_pager"] }, { targetType: "artifact", artifactKind: "deck" })).toBe(false);
    expect(scopeApplies({ nodeKinds: ["decision"] }, { targetType: "change_set", nodeKinds: ["decision", "meeting"] })).toBe(true);
    expect(scopeApplies({ nodeKinds: ["decision"] }, { targetType: "node", nodeKinds: ["meeting"] })).toBe(false);
    expect(scopeApplies({ tags: ["Energy"] }, { targetType: "wiki", tags: ["energy"] })).toBe(true);
    expect(scopeApplies({ tags: ["energy"] }, { targetType: "wiki" })).toBe(false);
  });

  const corpora = [
    { id: "law", status: "active", scope: { all: true }, checkByDefault: true },
    { id: "adr", status: "active", scope: { targetTypes: ["wiki" as const] }, checkByDefault: true },
    { id: "draft", status: "draft", scope: { all: true }, checkByDefault: true },
    { id: "opt", status: "active", scope: { all: true }, checkByDefault: false },
    { id: "old", status: "active", scope: { all: true }, checkByDefault: true, effectiveTo: "2020-01-01" },
    { id: "future", status: "active", scope: { all: true }, checkByDefault: true, effectiveFrom: "2999-01-01" },
  ];
  it("picks the graph's active, in-force default corpora whose scope covers the text", () => {
    expect(pickCorpora(corpora, { targetType: "wiki" }, { page: null, graph: null }).map((c) => c.id)).toEqual(["law", "adr"]);
    expect(pickCorpora(corpora, { targetType: "message" }, { page: null, graph: null }).map((c) => c.id)).toEqual(["law"]);
  });
  it("uses the graph default set, and a page's own choice even outside scope", () => {
    expect(pickCorpora(corpora, { targetType: "wiki" }, { page: null, graph: ["opt", "adr"] }).map((c) => c.id)).toEqual(["adr", "opt"]);
    expect(pickCorpora(corpora, { targetType: "message" }, { page: ["adr", "draft"], graph: null }).map((c) => c.id)).toEqual(["adr"]);
    expect(pickCorpora(corpora, { targetType: "wiki" }, { page: [], graph: null })).toEqual([]);
  });
  it("caps the rules, closest first, blockers winning ties", () => {
    const rules = [
      { id: "a", score: 0.5, severity: "minor" }, { id: "b", score: 0.9, severity: "minor" }, { id: "c", score: 0.5, severity: "blocker" }, { id: "d", score: 0.1, severity: "major" },
    ];
    expect(selectRules(rules, 10)).toBe(rules);
    expect(selectRules(rules, 2).map((r) => r.id)).toEqual(["b", "c"]);
  });
});

describe("the cache", () => {
  it("returns what was stored, forgets the oldest past its size and anything past its time", () => {
    let now = 0;
    const c = new TtlCache<number>(2, 1000, () => now);
    c.set("a", 1); c.set("b", 2);
    expect(c.get("a")).toBe(1); // a is now the most recent
    c.set("c", 3);
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")).toBe(1);
    now = 2000;
    expect(c.get("c")).toBeUndefined();
    expect(c.size).toBe(1);
  });
  it("keys a paragraph by its words, the rule set version, the rules and the language", () => {
    const base = { graphId: "g", ruleSet: ruleSetVersion([{ id: "x", rulesVersion: 1 }]), ruleIds: ["r1", "r2"], locale: "en", text: "Hello there" };
    expect(paragraphKey(base)).toBe(paragraphKey({ ...base, ruleIds: ["r2", "r1"] }));
    expect(paragraphKey(base)).not.toBe(paragraphKey({ ...base, text: "Hello there!" }));
    expect(paragraphKey(base)).not.toBe(paragraphKey({ ...base, locale: "da" }));
    expect(paragraphKey(base)).not.toBe(paragraphKey({ ...base, ruleSet: ruleSetVersion([{ id: "x", rulesVersion: 2 }]) }));
  });
});

describe("span mapping", () => {
  const text = "Intro to the flow.\n\nThe meter data flow goes from Datahub to the billing system. Nobody owns it yet.\n\nWe send readings to a partner.";
  const paragraphs = splitParagraphs(text);
  it("splits paragraphs with their offsets", () => {
    expect(paragraphs).toHaveLength(3);
    for (const p of paragraphs) expect(text.slice(p.start, p.end)).toBe(p.text);
  });
  it("finds the span in the named paragraph, forgiving case, spacing and quotes", () => {
    const raw = { findings: [{ rule: "R1", paragraph: 2, verdict: "non_compliant", span: "nobody  owns it yet", explanation: "This doesn't meet §16 stk. 2.", suggestion: "Grid Operations owns it." }] };
    const [f] = parseVerdicts(raw, { paragraphs, fullText: text, ruleIds: ["rule-1"] });
    expect(f.ruleId).toBe("rule-1");
    expect(text.slice(f.span!.start, f.span!.end)).toBe("Nobody owns it yet");
    expect(f.span!.approx).toBeUndefined();
    expect(f.paragraphKey).toBe(paragraphs[1].key);
  });
  it("looks elsewhere when the paragraph number is wrong, and falls back to the whole paragraph, marked approximate", () => {
    const raw = { findings: [
      { rule: 1, paragraph: 1, verdict: "violation", span: "We send readings to a partner." },
      { rule: "R2", paragraph: 2, verdict: "unclear", span: "words that are not there" },
      { rule: "R2", paragraph: 9, verdict: "non_compliant", span: "not there either" },
      { rule: "R7", paragraph: 1, verdict: "non_compliant", span: "Intro" },
      { rule: "R1", paragraph: 1, verdict: "compliant", span: "Intro" },
    ] };
    const out = parseVerdicts(raw, { paragraphs, fullText: text, ruleIds: ["a", "b"] });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ ruleId: "a", verdict: "non_compliant", span: { text: "We send readings to a partner." }, paragraphKey: paragraphs[2].key });
    expect(out[1]).toMatchObject({ ruleId: "b", verdict: "unclear", span: { start: paragraphs[1].start, approx: true } });
  });
  it("keeps missing obligations only when asked, without a span", () => {
    const raw = { findings: [{ rule: "R1", verdict: "missing", explanation: "ADR-4.2: name an owner." }] };
    expect(parseVerdicts(raw, { paragraphs, fullText: text, ruleIds: ["a"] })).toEqual([]);
    const [m] = parseVerdicts(raw, { paragraphs, fullText: text, ruleIds: ["a"], allowMissing: true });
    expect(m).toMatchObject({ verdict: "missing", span: null, paragraphKey: null });
  });
  it("moves cached findings with their paragraph", () => {
    const f: FreshFinding = { ruleId: "a", verdict: "non_compliant", explanation: "", suggestion: null, span: { start: 5, end: 9, text: "abcd" }, paragraphKey: "k", fingerprint: "x" };
    expect(shiftFindings([f], 0, 100)[0].span).toEqual({ start: 105, end: 109, text: "abcd" });
  });
  it("locates exact passages and refuses invented ones", () => {
    expect(locate("Stk. 2. Enhver “informationsstrøm” skal", "enhver \"informationsstrøm\" skal")).toEqual({ start: 8, end: 39 });
    expect(locate("abc", "xyz")).toBeNull();
  });
  it("maps document text back to blocks and fixes inside a text block", () => {
    const content = { subtitle: "", sections: [{ id: "s1", title: "Flows", blocks: [
      { id: "b1", type: "text", text: "The flow has no owner." },
      { id: "b2", type: "facts", items: [{ label: "Owner", value: "none", cites: [] }] },
    ] }] };
    const m = artifactText(content, "Data flows");
    const at = m.text.indexOf("has no owner");
    expect(blockAt(m, at)?.id).toBe("b1");
    expect(blockAt(m, m.text.indexOf("Owner: none"))?.id).toBe("b2");
    const fix = replaceInBlock(m, (id) => (id === "b1" ? "The flow has no owner." : null), at, at + 12, "has no owner", "is owned by Grid Operations");
    expect(fix).toEqual({ id: "b1", text: "The flow is owned by Grid Operations." });
    const facts = m.text.indexOf("none");
    expect(replaceInBlock(m, () => "x", facts, facts + 4, "none", "Grid")).toBeNull();
  });
});

describe("finding lifecycle", () => {
  const fresh = (ruleId: string, span: string | null, verdict: FreshFinding["verdict"] = "non_compliant"): FreshFinding => ({
    ruleId, verdict, explanation: "e", suggestion: null, span: span ? { start: 0, end: span.length, text: span } : null, paragraphKey: null, fingerprint: fingerprintOf(ruleId, verdict, span),
  });
  it("identifies a finding by rule and passage, folded", () => {
    expect(fingerprintOf("r", "non_compliant", "Nobody  owns it")).toBe(fingerprintOf("r", "non_compliant", "nobody owns it"));
    expect(fingerprintOf("r", "missing", null)).toBe(fingerprintOf("r", "missing", "anything"));
  });
  it("inserts new findings and fixes ones that are gone", () => {
    const a = fresh("r1", "nobody owns it");
    const stored = [{ id: "old", fingerprint: fingerprintOf("r1", "non_compliant", "we skip consent"), status: "open", verdict: "non_compliant" }];
    const r = reconcile(stored, [a]);
    expect(r.insert).toEqual([a]);
    expect(r.fix).toEqual(["old"]);
  });
  it("keeps an accepted deviation accepted, updates an open one, reopens a fixed one that came back", () => {
    const a = fresh("r1", "nobody owns it"), b = fresh("r2", "we skip consent"), c = fresh("r3", "no log");
    const stored = [
      { id: "1", fingerprint: a.fingerprint, status: "accepted", verdict: "non_compliant" },
      { id: "2", fingerprint: b.fingerprint, status: "open", verdict: "non_compliant" },
      { id: "3", fingerprint: c.fingerprint, status: "fixed", verdict: "non_compliant" },
    ];
    const r = reconcile(stored, [a, b, c, b]);
    expect(r.insert).toEqual([]);
    expect(r.update.map((u) => u.id)).toEqual(["2"]);
    expect(r.reopen.map((u) => u.id)).toEqual(["3"]);
    expect(r.fix).toEqual([]);
  });
  it("carries missing obligations when that check was skipped", () => {
    const stored = [{ id: "m", fingerprint: fingerprintOf("r9", "missing", null), status: "open", verdict: "missing" }];
    expect(reconcile(stored, [], { carry: ["missing"] }).fix).toEqual([]);
    expect(reconcile(stored, []).fix).toEqual(["m"]);
  });
  it("needs a reason to accept a deviation", () => {
    expect(acceptProblem("  ok ")).toMatch(/why/);
    expect(acceptProblem("The data owner is named in the appendix.")).toBeNull();
  });
  it("counts open findings by severity, missing ones and accepted deviations", () => {
    expect(countFindings([
      { status: "open", verdict: "non_compliant", severity: "blocker" },
      { status: "open", verdict: "missing", severity: "major" },
      { status: "accepted", verdict: "non_compliant", severity: "blocker" },
      { status: "fixed", verdict: "non_compliant", severity: "minor" },
    ])).toEqual({ blocker: 1, major: 1, minor: 0, info: 0, missing: 1, open: 2, accepted: 1 });
  });
});

describe("explanations", () => {
  it("never shows the prompt's rule ids", () => {
    const text = "We share meter data with Elsalg.";
    const [f] = parseVerdicts({ findings: [{ rule: "R1", paragraph: 1, verdict: "non_compliant", span: "share meter data", explanation: "This violates R1 because consent is missing." }] },
      { paragraphs: splitParagraphs(text), fullText: text, ruleIds: ["a"], refs: ["BEK 260 §16 stk. 2"] });
    expect(f.explanation).toBe("This violates BEK 260 §16 stk. 2 because consent is missing.");
  });
});

describe("redundant missing obligations", () => {
  it("drops 'missing' for a rule the text already breaks in words", async () => {
    const { dropRedundantMissing } = await import("./pure");
    const list = [{ ruleId: "a", verdict: "non_compliant" as const }, { ruleId: "a", verdict: "missing" as const }, { ruleId: "b", verdict: "missing" as const }];
    expect(dropRedundantMissing(list)).toEqual([list[0], list[2]]);
  });
});

describe("nothingClose", () => {
  it("is true only when every rule is far from the text", () => {
    expect(nothingClose([0.456, 0.437, 0.433])).toBe(true);
    expect(nothingClose([0.548, 0.44])).toBe(false);
    expect(nothingClose([0.47], { min: 0.46 })).toBe(false);
  });
  it("never skips without scores, or when a rule has no embedding yet", () => {
    expect(nothingClose([])).toBe(false);
    expect(nothingClose([0.41, 0.3])).toBe(false);
  });
});
