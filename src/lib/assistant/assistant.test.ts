import { describe, expect, it } from "vitest";
import { citedNumbers, extractCitations, formatLocator, numberContext, selectItems, type ContextItem } from "./context";
import { parseInline, parseMarkdown } from "./markdown";
import { buildMessages, cleanTitle, fallbackTitle, trimHistory } from "./prompt";
import { parseProposals, ProposalStreamFilter } from "./proposals";
import { chooseRoute } from "./route";
import { decodeState, encodeState, foldState } from "./state";
import { wikiDocFromText, wikiSlug } from "./wiki-doc";
import { degradedAnswer } from "./fallback";

const passage = (id: string, text: string, sensitive = false): ContextItem => ({ kind: "passage", sourceId: id, title: `Doc ${id}`, text, locator: { page: 2 }, sensitive });
const fact: ContextItem = {
  kind: "fact", edgeId: "e1", fromId: "n1", title: "Emma attends Lindevang School", status: "inferred", confidence: 0.55,
  sourceId: "s9", sourceTitle: "Welcome letter", quote: "Emma starts in 0.A", locator: { page: 1 }, sensitive: false,
};

describe("route heuristic", () => {
  it("uses fast for short lookups", () => {
    expect(chooseRoute("What's coming up for Emma this week?")).toBe("fast");
    expect(chooseRoute("When was Noah's last vaccination?")).toBe("fast");
    expect(chooseRoute("Hvornår har Emma svømning?")).toBe("fast");
  });
  it("uses smart for planning and reasoning", () => {
    expect(chooseRoute("Help me plan the autumn holiday")).toBe("smart");
    expect(chooseRoute("Why did the school move the meeting?")).toBe("smart");
    expect(chooseRoute("Hjælp mig med at planlægge Noahs fødselsdag")).toBe("smart");
    expect(chooseRoute("Who is coming? And when do they arrive?")).toBe("smart");
    expect(chooseRoute("x".repeat(200))).toBe("smart");
  });
  it("uses the local agent route when anything is sensitive", () => {
    expect(chooseRoute("When was Noah's last vaccination?", { sensitive: true })).toBe("agent");
    expect(chooseRoute("Help me plan", { sensitive: true })).toBe("agent");
  });
});

describe("context numbering and citations", () => {
  it("numbers items and builds citations with links and quotes", () => {
    const ctx = numberContext([passage("s1", "Swimming starts Thursday at 16:00."), fact]);
    expect(ctx.text).toContain('[1] Source: "Doc s1" · p2');
    expect(ctx.text).toContain("[2] Fact: Emma attends Lindevang School (inferred, confidence 0.55)");
    expect(ctx.citations[0]).toMatchObject({ n: 1, sourceId: "s1", locator: { page: 2 } });
    expect(ctx.citations[1]).toMatchObject({ n: 2, edgeId: "e1", nodeId: "n1", sourceId: "s9", confidence: 0.55, quote: "Emma starts in 0.A" });
    expect(ctx.sensitive).toBe(false);
    expect(numberContext([passage("s2", "x", true)]).sensitive).toBe(true);
    expect(numberContext([]).empty).toBe(true);
  });

  it("finds cited numbers in many forms", () => {
    expect(citedNumbers("A [1]. B [2][3]. C [1, 4]. D [5–7]. E [2-3]")).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(citedNumbers("no cites, [x] and [] and [0]")).toEqual([]);
  });

  it("keeps only citations that exist, sorted", () => {
    const ctx = numberContext([passage("a", "x"), passage("b", "y"), passage("c", "z")]);
    const used = extractCitations("See [3] and [1] and the invented [9].", ctx.citations);
    expect(used.map((c) => c.n)).toEqual([1, 3]);
  });

  it("deduplicates and respects budgets", () => {
    const items = [passage("a", "same"), passage("a", "same"), fact, fact];
    expect(selectItems(items)).toHaveLength(2);
    expect(selectItems([passage("a", "x".repeat(700)), passage("b", "y".repeat(700))], { maxChars: 1000 })).toHaveLength(1);
  });

  it("formats locators", () => {
    expect(formatLocator({ page: 3 })).toBe("p3");
    expect(formatLocator({ timeStartSec: 65, timeEndSec: 130 })).toBe("1:05–2:10");
    expect(formatLocator({})).toBe("");
  });
});

describe("proposals", () => {
  const block = '<proposals>[{"type":"propose_reminder","title":"Pack swim gear","dueAt":"2026-11-05T07:30:00+01:00","aboutPerson":"Emma"},{"type":"fact","from":"Emma","relation":"Attends Club","to":"Swim club"},{"type":"propose_wiki_note","title":"Swimming","text":"- Thursdays"},{"type":"propose_reminder","title":"Fourth","dueAt":"2026-11-06"}]</proposals>';

  it("splits visible text from proposals and validates them", () => {
    const { text, proposals } = parseProposals(`Swimming is on Thursday [1].\n\n${block}`);
    expect(text).toBe("Swimming is on Thursday [1].");
    expect(proposals).toHaveLength(3);
    expect(proposals[0]).toMatchObject({ type: "propose_reminder", aboutPerson: "Emma", detail: null });
    expect(proposals[1]).toMatchObject({ type: "propose_fact", relation: "attends_club" });
    expect(proposals[2].type).toBe("propose_wiki_note");
  });

  it("drops invalid proposals and survives broken JSON or a missing close tag", () => {
    expect(parseProposals('A <proposals>[{"type":"propose_reminder","title":"x","dueAt":"not a date"},{"type":"hack"}]</proposals>').proposals).toEqual([]);
    expect(parseProposals("A <proposals>[{oops</proposals>")).toEqual({ text: "A", proposals: [] });
    const open = parseProposals('Answer <proposals>[{"type":"propose_wiki_note","title":"T","text":"x"}]');
    expect(open.text).toBe("Answer");
    expect(open.proposals).toHaveLength(1);
    expect(parseProposals("Plain answer").proposals).toEqual([]);
  });

  it("keeps valid node types for new things in a fact and ignores bad ones", () => {
    const r = parseProposals('x <proposals>[{"type":"propose_fact","from":"Noah","relation":"member of","to":"B93","toType":"place","fromType":"spaceship"}]</proposals>');
    expect(r.proposals[0]).toMatchObject({ relation: "member_of", toType: "place", fromType: null });
  });

  it("accepts a fenced block and a {proposals: []} wrapper", () => {
    const r = parseProposals('x <proposals>```json\n{"proposals":[{"type":"propose_wiki_note","title":"T","text":"y"}]}\n```</proposals>');
    expect(r.proposals).toHaveLength(1);
  });

  it("stream filter hides the block even when the tag is split across deltas", () => {
    const f = new ProposalStreamFilter();
    const deltas = ["Answer [1].", " <prop", "osals>[{\"type\":", "\"x\"}]</proposals>"];
    const shown = deltas.map((d) => f.push(d)).join("") + f.flush();
    expect(shown).toBe("Answer [1]. ");
  });

  it("stream filter releases a held-back '<' that was not a block", () => {
    const f = new ProposalStreamFilter();
    const shown = f.push("a <") + f.push("b") + f.push(" <pro") + f.flush();
    expect(shown).toBe("a <b <pro");
  });
});

describe("markdown subset", () => {
  it("parses paragraphs, line breaks, lists and headings", () => {
    const blocks = parseMarkdown("# Plan\nFirst line\nsecond line\n\n- one\n- **two** [2]\n\n1. a\n2. b");
    expect(blocks.map((b) => b.t)).toEqual(["h", "p", "ul", "ol"]);
    expect(blocks[1]).toEqual({ t: "p", c: [{ t: "text", v: "First line" }, { t: "br" }, { t: "text", v: "second line" }] });
    const ul = blocks[2] as Extract<(typeof blocks)[number], { t: "ul" }>;
    expect(ul.items[1]).toEqual([{ t: "bold", c: [{ t: "text", v: "two" }] }, { t: "text", v: " " }, { t: "cite", ns: [2] }]);
  });

  it("parses inline citations, emphasis and code without touching HTML", () => {
    expect(parseInline("See [1, 3] and *this* `<b>`")).toEqual([
      { t: "text", v: "See " }, { t: "cite", ns: [1, 3] }, { t: "text", v: " and " },
      { t: "em", c: [{ t: "text", v: "this" }] }, { t: "text", v: " " }, { t: "code", v: "<b>" },
    ]);
    expect(parseInline("<script>alert(1)</script>")).toEqual([{ t: "text", v: "<script>alert(1)</script>" }]);
    expect(parseInline("snake_case_word and 2 * 3 * 4")).toEqual([{ t: "text", v: "snake_case_word and 2 * 3 * 4" }]);
    expect(parseInline("[link text] stays")).toEqual([{ t: "text", v: "[link text] stays" }]);
  });
});

describe("prompt", () => {
  it("puts the numbered context in the system prompt and the question last", () => {
    const msgs = buildMessages({ viewerName: "Anna", today: "Tuesday 3 November 2026", timeZone: "Europe/Copenhagen", context: "[1] Source: x", history: [{ role: "user", content: "hi" }, { role: "assistant", content: "Hello <proposals>[]</proposals>" }], question: "When?" });
    expect(msgs[0].role).toBe("system");
    expect(String(msgs[0].content)).toContain("[1] Source: x");
    expect(String(msgs[0].content)).toContain("cite it with its number");
    expect(msgs[2]).toEqual({ role: "assistant", content: "Hello" });
    expect(msgs.at(-1)).toEqual({ role: "user", content: "When?" });
  });

  it("trims history to recent turns and starts with a user turn", () => {
    const h = Array.from({ length: 30 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", content: `m${i}` }));
    const t = trimHistory(h, { maxTurns: 5 });
    expect(t[0].role).toBe("user");
    expect(t.length).toBeLessThanOrEqual(5);
    expect(t.at(-1)?.content).toBe("m29");
  });

  it("makes titles", () => {
    expect(fallbackTitle("when was noah's last vaccination?")).toBe("When was noah's last vaccination");
    expect(fallbackTitle("a ".repeat(100)).length).toBeLessThanOrEqual(61);
    expect(cleanTitle('"Title: Noah\'s vaccinations."', "q")).toBe("Noah's vaccinations");
    expect(cleanTitle("", "what is up")).toBe("What is up");
  });
});

describe("conversation state", () => {
  it("round-trips and folds decisions and sensitivity", () => {
    const a = encodeState({ type: "proposal", messageId: "m1", n: 1, status: "dismissed" });
    const b = encodeState({ type: "proposal", messageId: "m1", n: 1, status: "approved", result: { label: "Done", href: "/" } });
    const c = encodeState({ type: "sensitive" });
    expect(decodeState("ordinary text")).toBeNull();
    const s = foldState([a, "noise", b, c]);
    expect(s.sensitive).toBe(true);
    expect(s.decisions.get("m1#1")).toEqual({ status: "approved", result: { label: "Done", href: "/" } });
  });
});

describe("wiki doc", () => {
  it("turns text into TipTap JSON and slugs titles", () => {
    const doc = wikiDocFromText("## Swimming\n\nThursdays at 16:00\nBring a towel\n\n- goggles\n- cap") as { content: { type: string }[] };
    expect(doc.content.map((n) => n.type)).toEqual(["heading", "paragraph", "bulletList"]);
    expect(wikiSlug("Søren's Æble-plan for 2026!")).toBe("soerens-aeble-plan-for-2026");
    expect(wikiSlug("!!!")).toBe("note");
  });
});

describe("degraded answer", () => {
  it("explains the problem and lists matching items with citations", () => {
    const items = [passage("s1", "Swimming Thursday"), fact];
    const text = degradedAnswer("not_configured", numberContext(items), items);
    expect(text).toContain("MUX_API_KEY");
    expect(text).toContain("[1]");
    expect(text).toContain("Emma attends Lindevang School (inferred) [2]");
    expect(degradedAnswer("unreachable", numberContext([]), [])).toContain("couldn't find anything");
  });
});
