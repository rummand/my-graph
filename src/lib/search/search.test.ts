import { describe, expect, it } from "vitest";
import { likePattern, parseQuery, parseRef, prefixTsQuery, refRegex, searchable, textTerms } from "./query";
import { findRanges, foldCase, makeSnippet, mergeRanges, splitByRanges } from "./highlight";
import { labelScore, meaningScore, mergeHits, nameScore, pickTop, sortHits, textScore, TIER, TOP_HIT_MIN } from "./rank";
import { commandsFor, matchCommand, subsequence } from "./commands";
import { pushQuery, pushRecent, readList, recentKey, sectionsFor, snippetAllowed } from "./access";
import type { Hit } from "./types";

const hit = (p: Partial<Hit> & { key: string; score: number }): Hit => ({
  section: "nodes", kind: "person", id: p.key, title: p.key, href: "/", titleRanges: [], context: [], via: "title", ...p,
});

describe("parseQuery", () => {
  it("reads plain words, lower-cased and unique", () => {
    const p = parseQuery("  Emma  emma Skole ");
    expect(p.text).toBe("Emma emma Skole");
    expect(p.terms).toEqual(["emma", "skole"]);
    expect(p.filter).toBeNull();
  });

  it("keeps quoted phrases", () => {
    const p = parseQuery('"permission slip" Emma');
    expect(p.phrases).toEqual(["permission slip"]);
    expect(p.text).toBe("permission slip Emma");
    expect(p.terms).toEqual(["permission", "slip", "emma"]);
  });

  it("tolerates an unclosed quote", () => {
    expect(parseQuery('"tandlæge').phrases).toEqual(["tandlæge"]);
  });

  it("reads type prefixes in English and Danish", () => {
    expect(parseQuery("person: emma").filter).toMatchObject({ sections: ["nodes"], nodeTypes: ["person"], label: "person" });
    expect(parseQuery("file:lejekontrakt").filter?.sections).toEqual(["files"]);
    expect(parseQuery("fil: lejekontrakt").filter?.sections).toEqual(["files"]);
    expect(parseQuery("rule: § 3").filter?.sections).toEqual(["rules"]);
    expect(parseQuery("regel: § 3").filter?.sections).toEqual(["rules"]);
    expect(parseQuery("side: madplan").filter).toMatchObject({ sections: ["made"], madeKinds: ["page"] });
    expect(parseQuery("person: emma").text).toBe("emma");
  });

  it("leaves an unknown prefix as words", () => {
    const p = parseQuery("note: buy milk");
    expect(p.filter).toBeNull();
    expect(p.terms).toEqual(["note", "buy", "milk"]);
  });

  it("keeps Danish letters in terms", () => {
    expect(parseQuery("Tandlæge Søndergade Århus").terms).toEqual(["tandlæge", "søndergade", "århus"]);
  });

  it("is searchable only with words or a reference", () => {
    expect(searchable(parseQuery(""))).toBe(false);
    expect(searchable(parseQuery("!!"))).toBe(false);
    expect(searchable(parseQuery("§ 3"))).toBe(true);
    expect(searchable(parseQuery("e"))).toBe(true);
  });
});

describe("rule references", () => {
  it("parses § with and without stk.", () => {
    expect(parseRef("§ 3")).toEqual({ mark: "§", number: "3", stk: null });
    expect(parseRef("§16, stk. 2")).toEqual({ mark: "§", number: "16", stk: "2" });
    expect(parseRef("paragraf 16 stk 2")).toEqual({ mark: "§", number: "16", stk: "2" });
    expect(parseRef("Art. 6")).toEqual({ mark: "art.", number: "6", stk: null });
    expect(parseRef("emma")).toBeNull();
  });

  it("builds a regex that finds § 3 but not § 30", () => {
    const re = new RegExp(refRegex(parseRef("§ 3")!), "i");
    expect(re.test("§ 3")).toBe(true);
    expect(re.test("§3, stk. 2")).toBe(true);
    expect(re.test("§ 30")).toBe(false);
    const stk = new RegExp(refRegex(parseRef("§ 16 stk. 2")!), "i");
    expect(stk.test("§ 16, stk. 2")).toBe(true);
    expect(stk.test("§ 16, stk. 21")).toBe(false);
  });

  it("drops the reference's own tokens from text terms", () => {
    expect(textTerms(parseQuery("Lejeloven § 182"))).toEqual(["lejeloven"]);
  });
});

describe("SQL helpers", () => {
  it("builds prefix tsqueries", () => {
    expect(prefixTsQuery(["tandlæge", "noah"])).toBe("tandlæge:* & noah:*");
    expect(prefixTsQuery(["a"], true)).toBe("a:*");
    expect(prefixTsQuery([])).toBeNull();
  });
  it("escapes LIKE wildcards", () => {
    expect(likePattern("50%_off\\")).toBe("%50\\%\\_off\\\\%");
  });
});

describe("highlight", () => {
  it("folds case without moving offsets, Danish letters included", () => {
    expect(foldCase("TANDLÆGE Øster ÅRHUS")).toBe("tandlæge øster århus");
    expect(foldCase("İstanbul").length).toBe("İstanbul".length);
  });

  it("finds word starts, case-insensitively, with offsets into the original", () => {
    const s = "Tandlægerne Søndergade";
    expect(findRanges(s, ["tandlæge"])).toEqual([[0, 8]]);
    expect(findRanges(s, ["SØNDER"])).toEqual([[12, 18]]);
  });

  it("falls back to inside a word when no word starts with it", () => {
    expect(findRanges("Noahs tandlæge", ["læge"])).toEqual([[10, 14]]);
  });

  it("prefers word starts over matches inside words", () => {
    expect(findRanges("tandlæge og læge", ["læge"])).toEqual([[12, 16]]);
  });

  it("merges overlapping ranges", () => {
    expect(mergeRanges([[5, 8], [0, 3], [2, 4], [8, 9]])).toEqual([[0, 4], [5, 9]]);
    expect(findRanges("Emma Hansen", ["emma han", "emma"])).toEqual([[0, 8]]);
  });

  it("cuts a snippet around the first match with relative offsets", () => {
    const text = `${"Lorem ipsum dolor sit amet. ".repeat(10)}Mødet om lejekontrakten er på torsdag. ${"Mere tekst her. ".repeat(10)}`;
    const sn = makeSnippet(text, ["lejekontrakt"], 120);
    expect(sn.text.startsWith("…")).toBe(true);
    expect(sn.text.endsWith("…")).toBe(true);
    expect(sn.ranges.length).toBe(1);
    const [a, b] = sn.ranges[0];
    expect(sn.text.slice(a, b).toLowerCase()).toBe("lejekontrakt");
  });

  it("keeps short texts whole", () => {
    expect(makeSnippet("Emma's swimming", ["emma"])).toEqual({ text: "Emma's swimming", ranges: [[0, 4]] });
  });

  it("splits text into marked parts", () => {
    expect(splitByRanges("Æble og pære", [[0, 4], [8, 12]])).toEqual([
      { text: "Æble", hit: true }, { text: " og ", hit: false }, { text: "pære", hit: true },
    ]);
  });
});

describe("ranking", () => {
  it("orders exact > prefix > word prefix > contains > all words", () => {
    const s = (name: string, q: string) => nameScore(name, q, parseQuery(q).terms);
    expect(s("Emma", "emma")).toBe(TIER.exact);
    expect(s("Emma Hansen", "emma")).toBeGreaterThan(s("Little Emma", "emma"));
    expect(s("Little Emma", "emma")).toBe(TIER.wordPrefix);
    expect(s("Gemma", "emma")).toBe(TIER.contains);
    expect(s("Hansen, Emma", "emma hansen")).toBe(TIER.wordPrefix);
    expect(s("Noah", "emma")).toBe(0);
  });

  it("ranks an alias below the name", () => {
    expect(labelScore("Margrethe", ["Mormor"], "mormor", ["mormor"])).toEqual({ score: TIER.aliasExact, via: "alias" });
    expect(labelScore("Mormor", ["Margrethe"], "mormor", ["mormor"])).toEqual({ score: TIER.exact, via: "title" });
    expect(labelScore("Noah", [], "emma", ["emma"])).toBeNull();
  });

  it("keeps text and meaning below every name tier", () => {
    expect(textScore(1)).toBeLessThan(TIER.aliasContains);
    expect(textScore(0)).toBe(TIER.text);
    expect(meaningScore(1)).toBeLessThan(TIER.text);
  });

  it("merges duplicate hits keeping the best score and any snippet", () => {
    const a = hit({ key: "file:1", score: 40, via: "text", snippet: { text: "…x…", ranges: [] } });
    const b = hit({ key: "file:1", score: 90, via: "title" });
    const [m] = mergeHits([[a], [b]]);
    expect(m.score).toBe(90);
    expect(m.snippet?.text).toBe("…x…");
  });

  it("sorts by relevance or by date", () => {
    const old = hit({ key: "a", score: 90, date: "2020-01-01T00:00:00Z" });
    const fresh = hit({ key: "b", score: 40, date: "2026-01-01T00:00:00Z" });
    expect(sortHits([fresh, old]).map((h) => h.key)).toEqual(["a", "b"]);
    expect(sortHits([old, fresh], "newest").map((h) => h.key)).toEqual(["b", "a"]);
  });

  it("picks a top hit only for a name match, ties to the earlier section", () => {
    const textOnly = hit({ key: "t", score: 40 });
    expect(pickTop([{ id: "nodes", items: [textOnly] }])).toBeNull();
    const file = hit({ key: "f", section: "files", score: 92 });
    const person = hit({ key: "p", score: 92 });
    expect(pickTop([{ id: "files", items: [file] }, { id: "nodes", items: [person] }])?.key).toBe("p");
    expect(TOP_HIT_MIN).toBe(TIER.allWords);
  });
});

describe("commands", () => {
  it("matches by label, then keyword, then letters in order", () => {
    expect(matchCommand("New page", [], "new page")?.score).toBe(TIER.exact);
    expect(matchCommand("New page", [], "new")!.ranges).toEqual([[0, 3]]);
    expect(matchCommand("Settings", ["indstillinger"], "indstil")!.score).toBeGreaterThanOrEqual(40);
    expect(matchCommand("Timeline", [], "tmln")!.score).toBeLessThan(TOP_HIT_MIN);
    expect(matchCommand("Settings", [], "sg")).toBeNull();
    expect(matchCommand("Settings", [], "zzz")).toBeNull();
  });

  it("finds Danish labels and English keywords", () => {
    expect(matchCommand("Indstillinger", ["settings"], "indst")!.score).toBeGreaterThan(TOP_HIT_MIN);
    expect(matchCommand("Ny side", ["new page", "create page"], "new page")!.score).toBeGreaterThanOrEqual(40);
  });

  it("does subsequence matching with ranges", () => {
    expect(subsequence("Timeline", "tml")).toEqual([[0, 1], [2, 3], [4, 5]]);
    expect(subsequence("Today", "xy")).toBeNull();
  });

  it("hides commands a role may not use", () => {
    const ids = (r: string) => commandsFor(r).map((c) => c.id);
    expect(ids("guest")).not.toContain("newPage");
    expect(ids("guest")).not.toContain("rules");
    expect(ids("child")).not.toContain("rules");
    expect(ids("parent")).toContain("rules");
  });
});

describe("access helpers", () => {
  it("gives guests graph items only and children no rules", () => {
    expect(sectionsFor({ id: "g", role: "guest" })).toEqual(["nodes", "events"]);
    expect(sectionsFor({ id: "c", role: "child" })).not.toContain("rules");
    expect(sectionsFor({ id: "p", role: "parent" })).toContain("rules");
  });

  it("shows a passage of a sensitive item only to its owner", () => {
    expect(snippetAllowed({ id: "anna", role: "owner" }, { ownerId: "anna", sensitive: true })).toBe(true);
    expect(snippetAllowed({ id: "mikkel", role: "parent" }, { ownerId: "anna", sensitive: true })).toBe(false);
    expect(snippetAllowed({ id: "mikkel", role: "parent" }, { ownerId: "anna", sensitive: false })).toBe(true);
  });

  it("keeps recents per graph", () => {
    expect(recentKey("g1", "items")).not.toBe(recentKey("g2", "items"));
  });

  it("pushes recents to the front without duplicates", () => {
    const list = pushRecent([{ key: "a" }, { key: "b" }], { key: "b" }, 2);
    expect(list.map((x) => x.key)).toEqual(["b", "a"]);
    expect(pushQuery(["Emma"], "emma")).toEqual(["emma"]);
    expect(pushQuery(["Emma"], "e")).toEqual(["Emma"]);
  });

  it("reads stored lists defensively", () => {
    const isStr = (x: unknown): x is string => typeof x === "string";
    expect(readList("not json", isStr)).toEqual([]);
    expect(readList('{"a":1}', isStr)).toEqual([]);
    expect(readList('["a", 1, "b"]', isStr)).toEqual(["a", "b"]);
  });
});

describe("jsonText", () => {
  it("collects the words of a document, not its keys or ids", async () => {
    const { jsonText } = await import("./highlight");
    const doc = { id: "0b3c5a0e-1111-4222-8333-444455556666", sections: [{ kind: "summary", heading: "Skolestart", body: "Emma starter i 0. klasse" }] };
    expect(jsonText(doc)).toBe("Skolestart Emma starter i 0. klasse");
  });
});

describe("short words", () => {
  it("match only at word starts", async () => {
    const { wordStartRegex } = await import("./query");
    const re = new RegExp(wordStartRegex("ny"), "i");
    expect(re.test("Ny side")).toBe(true);
    expect(re.test("en ny side")).toBe(true);
    expect(re.test("any relevant")).toBe(false);
    expect(new RegExp(wordStartRegex("år"), "i").test("for 2 år siden")).toBe(true);
    expect(new RegExp(wordStartRegex("år"), "i").test("hår")).toBe(false);
    expect(findRanges("Consider any", ["ny"])).toEqual([]);
  });
});
