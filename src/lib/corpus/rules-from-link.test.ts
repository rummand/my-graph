/**
 * "Add from a link": classification, link selection and limits, the crawl on fixtures (no network), § and article
 * units (stk., nr., litra, points), the verbatim-quote check, coverage and completeness, and the diff on re-crawl.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyUrl, describe as describePage, parseClassification } from "./crawl/classify";
import { celexOf, euTitle, languageOf } from "./crawl/eurlex";
import { extractLinks, htmlToText } from "./crawl/html";
import { DEFAULT_LIMITS, normalizeUrl, selectLinks } from "./crawl/links";
import { eliOf, lexDaniaMeta, lexDaniaToText, popularName, relatedFromLinks, relatedFromReferences } from "./crawl/retsinformation";
import { parseRobots } from "./crawl/robots";
import { crawl, type CrawlDoc, type Fetched } from "./crawl/engine";
import { detectFamily, normalizeUnitRef, parseUnits, refsOf, resolveUnit } from "./read/units";
import { accountFor, coverageOf, definitionsIn, diffUnits, interpretationLinks, pageOf, passagesFor, rereadList, topsToReread, unitStates } from "./read/analysis";
import { jsonOf, parseReading, parseUnderstanding } from "./read/prompts";

const here = path.dirname(fileURLToPath(import.meta.url));
const LOV_XML = readFileSync(path.join(here, "__fixtures__/retsinfo-lov.xml"), "utf8");
const EU_XHTML = readFileSync(path.join(here, "__fixtures__/eurlex-reg.xhtml"), "utf8");
const LOV = lexDaniaToText(LOV_XML);
const EU = htmlToText(EU_XHTML, { keepChrome: true });

/* ── Classification ──────────────────────────────────────────────────────────────────────────────────────── */

describe("what a pasted link is", () => {
  it("knows Retsinformation by its ELI address, with or without /xml or /pdf", () => {
    expect(classifyUrl("https://www.retsinformation.dk/eli/lta/2023/1081")).toEqual({ site: "retsinformation", eli: "/eli/lta/2023/1081" });
    expect(eliOf("https://retsinformation.dk/eli/lta/2024/289/pdf")).toBe("/eli/lta/2024/289");
    expect(eliOf("https://www.retsinformation.dk/eli/retsinfo/2022/9441")).toBe("/eli/retsinfo/2022/9441");
    expect(eliOf("https://example.com/eli/lta/2023/1")).toBeNull();
  });
  it("knows EUR-Lex by CELEX or ELI, and the language", () => {
    expect(celexOf("https://eur-lex.europa.eu/legal-content/DA/TXT/?uri=CELEX:32016R0679")).toBe("32016R0679");
    expect(celexOf("https://eur-lex.europa.eu/eli/reg/2016/679/oj")).toBe("32016R0679");
    expect(celexOf("https://eur-lex.europa.eu/eli/dir/2019/1937/oj")).toBe("32019L1937");
    expect(celexOf("https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A02016R0679-20160504")).toBe("02016R0679-20160504");
    expect(languageOf("https://eur-lex.europa.eu/legal-content/DA/TXT/?uri=CELEX:32016R0679")).toBe("da");
    expect(classifyUrl("https://eur-lex.europa.eu/eli/reg/2016/679/oj")).toMatchObject({ site: "eurlex", celex: "32016R0679", lang: "en" });
  });
  it("knows a PDF, an authority's guidance and other pages", () => {
    expect(classifyUrl("https://example.org/files/Husorden-2024.pdf")).toEqual({ site: "pdf" });
    expect(classifyUrl("https://www.datatilsynet.dk/regler-og-vejledning/vejledninger")).toMatchObject({ site: "web", official: true, guidance: true });
    expect(classifyUrl("https://www.boligforening.dk/husorden")).toMatchObject({ site: "web", official: false });
  });
  it("names a Danish act from its XML: popular name, kind, authority, version, date", () => {
    const m = lexDaniaMeta(LOV_XML);
    expect(m).toMatchObject({ docType: "LOV", number: "512", documentId: "900001", ministry: "Social-, Bolig- og Ældreministeriet", startDate: "2024-07-01", shortName: "LOV nr 512 af 23/05/2024" });
    expect(popularName(m.title)).toBe("Boligordensloven");
    const d = describePage({ url: "https://www.retsinformation.dk/eli/lta/2024/512", site: { site: "retsinformation", eli: "/eli/lta/2024/512" }, title: m.title!, text: LOV,
      meta: { docType: m.docType, shortName: m.shortName, popular: popularName(m.title), ministry: m.ministry, startDate: m.startDate } });
    expect(d).toMatchObject({ name: "Boligordensloven", kind: "law", binding: "mandatory", version: "LOV nr 512 af 23/05/2024", effectiveFrom: "2024-07-01", family: "dk", sure: true });
    const vej = describePage({ url: "x", site: { site: "retsinformation", eli: "/eli/retsinfo/2022/1" }, title: "Vejledning om husorden", text: "", meta: { docType: "VEJ" } });
    expect(vej).toMatchObject({ kind: "guidelines", binding: "advisory" });
  });
  it("names an EU act from its first lines", () => {
    expect(euTitle(EU)).toMatchObject({ popular: "Key Safety Regulation", date: "3 March 2099" });
    expect(euTitle(EU).title).toMatch(/^Regulation \(EU\) 2099\/42 of the European Parliament/);
  });
  it("is sure about a page whose title names the kind, and asks the model otherwise", () => {
    const house = describePage({ url: "https://www.afdeling.dk/husorden", site: classifyUrl("https://www.afdeling.dk/husorden"), title: "Husorden for afdeling 12", text: "Beboerne skal …" });
    expect(house).toMatchObject({ kind: "house_rules", sure: true, binding: "mandatory" });
    const vague = describePage({ url: "https://example.com/info", site: classifyUrl("https://example.com/info"), title: "Information", text: "Velkommen" });
    expect(vague.sure).toBe(false);
    const asked = parseClassification({ kind: "school", name: "Ordensregler på Skovskolen", authority: "Skovskolen", version: null, effective_from: "2024-08-01", binding: "mandatory" }, vague);
    expect(asked).toMatchObject({ kind: "school", name: "Ordensregler på Skovskolen", effectiveFrom: "2024-08-01", sure: true });
    expect(() => parseClassification({ kind: "nonsense", name: "x" }, vague)).toThrow();
  });
});

/* ── Links and limits ────────────────────────────────────────────────────────────────────────────────────── */

describe("which links are followed", () => {
  const start = "https://www.skole.dk/regler/ordensregler/";
  const html = `<html><body>
    <nav><a href="/login">Log ind</a></nav>
    <a href="/regler/ordensregler/kapitel-1">Kapitel 1 Mødetider</a>
    <a href="/regler/ordensregler/kapitel-2#top">Kapitel 2 Mobiltelefoner</a>
    <a href="/regler/ordensregler/print">Udskriv hele teksten</a>
    <a href="/files/ordensregler.pdf">Hent som PDF</a>
    <a href="https://www.uvm.dk/vejledning-om-ordensregler">Vejledning om ordensregler</a>
    <a href="https://www.facebook.com/skole">Facebook</a>
    <a href="https://random-blog.example.com/regler">Andres regler</a>
    <a href="/billeder/logo.png">Logo</a>
    <a href="mailto:kontor@skole.dk">Skriv til os</a>
    <a href="/soeg?q=regler">Søg</a>
  </body></html>`;
  const links = extractLinks(html, start);
  it("reads links, resolved, without fragments", () => {
    expect(links.map((l) => l.url)).toContain("https://www.skole.dk/regler/ordensregler/kapitel-2");
    expect(links.some((l) => l.url.startsWith("mailto:"))).toBe(false);
  });
  it("keeps parts, the one-page view, the PDF and official guidance; drops the rest", () => {
    const picked = selectLinks({ url: start, depth: 0 }, links, { startUrl: start, visited: new Set(), limits: DEFAULT_LIMITS });
    const by = Object.fromEntries(picked.map((c) => [new URL(c.url).pathname, c]));
    expect(picked[0].kind).toBe("full");
    expect(by["/regler/ordensregler/kapitel-1"]).toMatchObject({ kind: "part", role: "text" });
    expect(by["/files/ordensregler.pdf"]).toMatchObject({ kind: "pdf", role: "text" });
    expect(by["/vejledning-om-ordensregler"]).toMatchObject({ kind: "linked", role: "interpretation" });
    expect(picked.map((c) => c.url).some((u) => /facebook|random-blog|logo|soeg|login/.test(u))).toBe(false);
  });
  it("follows guidance only from the start page, and nothing past the depth limit", () => {
    const one = selectLinks({ url: `${start}kapitel-1`, depth: 1 }, links, { startUrl: start, visited: new Set(), limits: DEFAULT_LIMITS });
    expect(one.some((c) => c.kind === "linked")).toBe(false);
    expect(selectLinks({ url: start, depth: 2 }, links, { startUrl: start, visited: new Set(), limits: DEFAULT_LIMITS })).toEqual([]);
  });
  it("drops tracking parameters when comparing addresses", () => {
    expect(normalizeUrl("https://Example.dk:443/a?utm_source=x&id=2#s")).toBe("https://example.dk/a?id=2");
  });
  it("reads robots.txt: longest match wins, Allow breaks ties, our agent's group first", () => {
    const r = parseRobots("User-agent: *\nDisallow: /private\nAllow: /private/public\nCrawl-delay: 3\n\nUser-agent: Other\nDisallow: /");
    expect(r.allows("/private/x")).toBe(false);
    expect(r.allows("/private/public/y")).toBe(true);
    expect(r.allows("/regler")).toBe(true);
    expect(r.delayMs).toBe(3000);
    expect(parseRobots("User-agent: MyGraph-RuleReader\nDisallow: /\n\nUser-agent: *\nAllow: /").allows("/a")).toBe(false);
    expect(parseRobots("User-agent: *\nDisallow: /*.pdf$").allows("/a/b.pdf")).toBe(false);
  });
});

/* ── The crawl, on fixtures ──────────────────────────────────────────────────────────────────────────────── */

const enc = new TextEncoder();
const PDF_BYTES = enc.encode("%PDF-1.4 fake");
const ok = (url: string, type: string, body: string | Uint8Array): Fetched => ({ url, status: 200, type, body: typeof body === "string" ? enc.encode(body) : body });

function fakeIO(pages: Record<string, () => Fetched>, opts: { deny?: RegExp } = {}) {
  const docs: CrawlDoc[] = [];
  const fetched: string[] = [];
  const demoted: string[] = [];
  return {
    docs, fetched, demoted,
    io: {
      fetch: async (url: string) => { fetched.push(url); const p = pages[url]; if (!p) return { url, status: 404, type: "text/html", body: enc.encode("") }; return p(); },
      robotsAllow: async (url: string) => !opts.deny?.test(url),
      onDoc: async (d: CrawlDoc) => { docs.push(d); },
      onDemote: async (url: string) => { demoted.push(url); },
    },
  };
}

describe("the crawl", () => {
  it("Retsinformation: reads the consolidated text instead of the pasted act, its PDF, guidance one level out; names the EU act", async () => {
    const R = "https://www.retsinformation.dk";
    const consolidatedXml = LOV_XML.replace("<DocumentType>LOV H</DocumentType>", "<DocumentType>LBK H</DocumentType>").replace("<UniqueDocumentId>900001", "<UniqueDocumentId>900002").replace("<Number>512", "<Number>77");
    const f = fakeIO({
      [`${R}/eli/lta/2024/512/xml`]: () => ok(`${R}/eli/lta/2024/512/xml`, "application/xml", LOV_XML),
      [`${R}/api/document/900001/references/0`]: () => ok("", "application/json", JSON.stringify({ referenceGroups: [{ header: "Konsolideret ved", references: [{ id: 900002, shortName: "LBK nr 77", title: "Bekendtgørelse af boligordensloven", eliPath: "/eli/lta/2025/77", isHistorical: false }] }] })),
      [`${R}/eli/lta/2025/77/xml`]: () => ok(`${R}/eli/lta/2025/77/xml`, "application/xml", consolidatedXml),
      [`${R}/api/document/900002/references/0`]: () => ok("", "application/json", JSON.stringify({
        referenceGroups: [{ header: "Senere ændringer til forskriften", references: [] }],
        euReferenceGroups: [{ references: [{ reference: "32099R0042" }] }],
        documentLinkGroups: [{ header: "Alle bekendtgørelser m.v.", data: "900002", type: 3 }],
      })),
      [`${R}/eli/lta/2025/77/pdf`]: () => ok(`${R}/eli/lta/2025/77/pdf`, "application/pdf", PDF_BYTES),
      [`${R}/api/document/documentLinks/3/900002`]: () => ok("", "application/json", JSON.stringify([
        { id: 1, shortName: "VEJ nr 9", title: "Vejledning om boligorden", eliPath: "/eli/retsinfo/2025/9", isHistorical: false },
        { id: 2, shortName: "BEK nr 8", title: "Bekendtgørelse om klager", eliPath: "/eli/lta/2025/8", isHistorical: false },
        { id: 3, shortName: "BEK nr 1", title: "Gammel", eliPath: "/eli/lta/2001/1", isHistorical: true },
      ])),
      [`${R}/eli/retsinfo/2025/9/xml`]: () => ok("", "application/xml", LOV_XML.replace("<DocumentType>LOV H", "<DocumentType>VEJ H")),
      [`${R}/eli/lta/2025/8/xml`]: () => ok("", "application/xml", LOV_XML.replace("<DocumentType>LOV H", "<DocumentType>BEK H")),
    });
    const r = await crawl(`${R}/eli/lta/2024/512`, f.io);
    expect(r.mainUrl).toBe(`${R}/eli/lta/2025/77`);
    expect(r.description).toMatchObject({ kind: "law", version: "LBK nr 77 af 23/05/2024" });
    const by = f.docs.map((d) => [d.url.replace(R, ""), d.format, d.role, d.reference] as const);
    expect(by).toEqual([
      ["/eli/lta/2025/77", "lexdania", "text", false],
      ["/eli/lta/2025/77/pdf", "pdf", "text", true],
      ["/eli/lta/2024/512", "lexdania", "supporting", false],
      ["/eli/retsinfo/2025/9", "lexdania", "interpretation", false],
      ["/eli/lta/2025/8", "lexdania", "supporting", false],
    ]);
    expect(r.related.map((x) => x.relation)).toEqual(["eu"]);
    expect(f.fetched.some((u) => u.includes("/2001/1"))).toBe(false);
  });

  it("any page: prefers the one-page view over the chapters, takes the PDF and guidance, respects robots.txt and the page limit", async () => {
    const S = "https://www.skole.dk/regler/";
    const long = "Eleverne skal møde til tiden. ".repeat(40);
    const f = fakeIO({
      [S]: () => ok(S, "text/html", `<html><head><title>Ordensregler for Skovskolen</title></head><body><p>${"Indhold. ".repeat(50)}</p>
        <a href="${S}kapitel-1">Kapitel 1</a><a href="${S}print">Udskriv hele teksten</a><a href="${S}regler.pdf">PDF</a>
        <a href="https://www.uvm.dk/vejledning">Vejledning om ordensregler</a><a href="${S}hemmelig/bilag.pdf">Bilag som PDF</a></body></html>`),
      [`${S}print`]: () => ok(`${S}print`, "text/html", `<html><body><p>${long}</p></body></html>`),
      [`${S}regler.pdf`]: () => ok(`${S}regler.pdf`, "application/pdf", PDF_BYTES),
      ["https://www.uvm.dk/vejledning"]: () => ok("https://www.uvm.dk/vejledning", "text/html", `<html><body><p>${"Vejledning. ".repeat(30)}</p></body></html>`),
    }, { deny: /hemmelig/ });
    const r = await crawl(S, f.io);
    expect(r.description).toMatchObject({ kind: "school", sure: true });
    expect(f.docs.map((d) => d.url)).toEqual([S, `${S}print`, `${S}regler.pdf`, "https://www.uvm.dk/vejledning"]);
    expect(f.demoted).toEqual([S]);
    expect(r.skipped.map((s) => s.why)).toEqual(expect.arrayContaining(["not_followed", "robots"]));
    expect(f.fetched).not.toContain(`${S}kapitel-1`);
    const limited = fakeIO({ [S]: () => ok(S, "text/html", `<html><body><p>${long}</p><a href="${S}kapitel-1">Kapitel 1</a><a href="${S}kapitel-2">Kapitel 2</a></body></html>`), [`${S}kapitel-1`]: () => ok(`${S}kapitel-1`, "text/html", `<p>${long}</p>`) });
    const r2 = await crawl(S, limited.io, { ...DEFAULT_LIMITS, maxPages: 2 });
    expect(r2.pages).toBe(2);
    expect(r2.skipped).toEqual(expect.arrayContaining([expect.objectContaining({ why: "limit" })]));
  });
});

describe("Retsinformation's API answers", () => {
  it("reads consolidated versions, amendments and EU acts; and the orders and guidance lists", () => {
    const r = relatedFromReferences({ referenceGroups: [{ header: "Senere ændringer til forskriften", references: [{ id: 5, shortName: "LOV nr 1", eliPath: "/eli/lta/2023/1", isHistorical: false }] }], documentLinkGroups: [{ data: "9", type: 13, header: "Vejledninger" }, { data: "9", type: 6, header: "Afgørelser" }] });
    expect(r.related).toEqual([expect.objectContaining({ relation: "amendment", url: "https://www.retsinformation.dk/eli/lta/2023/1" })]);
    expect(r.linkLists).toEqual([{ type: 13, data: "9", header: "Vejledninger" }]);
    expect(relatedFromLinks([{ shortName: "CIR nr 2", href: "/eli/retsinfo/2020/2", isHistoric: false }, { shortName: "BEK nr 3", eliPath: "/eli/lta/2020/3", isHistorical: true }]).map((x) => [x.relation, x.historical])).toEqual([["guidance", false], ["order", true]]);
  });
});

/* ── Pass 1: units ───────────────────────────────────────────────────────────────────────────────────────── */

describe("units of a Danish act (§, stk., nr., litra)", () => {
  const units = parseUnits(LOV);
  const keys = units.map((u) => u.key);
  it("renders the XML as plain law text", () => {
    expect(LOV).toContain("Kapitel 1\n\nAnvendelsesområde og definitioner");
    expect(LOV).toContain("§ 1. Loven gælder for almene boligforeninger.");
    expect(LOV).toContain("Stk. 2. Loven gælder dog ikke for kollegier, jf. § 4.");
    expect(LOV).toContain("1) Beboer: En person, der lejer en bolig i foreningen.");
    expect(detectFamily(LOV)).toBe("dk");
  });
  it("finds every unit, with stk., nr. and litra under their §", () => {
    expect(keys).toEqual(expect.arrayContaining(["Kapitel 1", "§ 1", "§ 1, stk. 2", "§ 2, nr. 1", "§ 3, stk. 2, nr. 1", "§ 3, stk. 2, nr. 1, litra a", "§ 3, stk. 2, nr. 2", "§ 5, stk. 2"]));
    const litra = units.find((u) => u.key === "§ 3, stk. 2, nr. 1, litra b")!;
    expect(litra).toMatchObject({ kind: "litra", parentKey: "§ 3, stk. 2, nr. 1", top: "§ 3", chapter: "Kapitel 2 Pligter" });
    expect(LOV.slice(litra.start, litra.end)).toBe("b) varighed,");
  });
  it("flags definitions, deadlines, penalties, commencement and repeal, and reads cross-references", () => {
    const f = (k: string) => units.find((u) => u.key === k)!.flags;
    expect(f("§ 2")).toContain("definition");
    expect(f("§ 3, stk. 2")).toContain("deadline");
    expect(f("§ 4")).toContain("penalty");
    expect(f("§ 5")).toContain("commencement");
    expect(f("§ 5, stk. 2")).toContain("repeal");
    expect(units.find((u) => u.key === "§ 4")!.refs).toEqual([{ ref: "§ 3, stk. 1", unitKey: "§ 3" }]);
    expect(units.find((u) => u.key === "§ 5, stk. 2")!.refs[0]).toMatchObject({ external: true });
  });
  it("tells this act's § from another act's", () => {
    const r = refsOf("jf. § 155, stk. 1, i retsplejeloven, og § 12 a, stk. 2, og §§ 6-8", { key: "§ 1", top: "§ 1" }, "dk");
    expect(r).toEqual(expect.arrayContaining([
      expect.objectContaining({ external: true }), expect.objectContaining({ unitKey: "§ 12 a, stk. 2" }),
      expect.objectContaining({ unitKey: "§ 6" }), expect.objectContaining({ unitKey: "§ 7" }), expect.objectContaining({ unitKey: "§ 8" })]));
    expect(r.some((x) => x.unitKey === "§ 155")).toBe(false);
  });
  it("finds definitions without a model", () => {
    expect(definitionsIn(units).map((d) => [d.unitKey, d.term])).toEqual([["§ 2, nr. 1", "Beboer"], ["§ 2, nr. 2", "Fællesareal"]]);
  });
});

describe("units of an EU act (articles, paragraphs, points, recitals)", () => {
  const units = parseUnits(EU);
  it("finds recitals, chapters, articles, paragraphs, points and sub-points", () => {
    expect(detectFamily(EU)).toBe("eu");
    expect(units.map((u) => u.key)).toEqual(expect.arrayContaining(["Recital 1", "Recital 2", "Chapter I", "Art. 1", "Art. 2(1)", "Art. 2(2)(a)", "Art. 3(1)", "Art. 3(2)(a)", "Art. 3(2)(b)", "Art. 4(2)"]));
    expect(units.find((u) => u.key === "Art. 3")!.label).toBe("Art. 3 Keeping keys");
    expect(units.find((u) => u.key === "Art. 3(2)(b)")!.refs).toEqual([{ ref: "Article 4(1)", unitKey: "Art. 4(1)" }]);
    expect(units.find((u) => u.key === "Art. 4(1)")!.flags).toContain("deadline");
  });
  it("finds the defined terms", () => {
    expect(definitionsIn(units).map((d) => d.term)).toEqual(["Key", "Keeper"]);
  });
  it("normalises and resolves references people and models write", () => {
    expect(normalizeUnitRef("Article 6(1)(a)")).toBe("Art. 6(1)(a)");
    expect(normalizeUnitRef("artikel 6, stk. 1, litra a")).toBe("Art. 6(1)(a)");
    expect(normalizeUnitRef("§16 Stk 2")).toBe("§ 16, stk. 2");
    expect(resolveUnit("Art. 3(2)(c)", units)?.key).toBe("Art. 3(2)");
    expect(resolveUnit("§ 3, stk. 1", parseUnits(LOV))?.key).toBe("§ 3");
    expect(resolveUnit("§ 99", parseUnits(LOV))).toBeNull();
  });
});

/* ── Passes 2–4 ──────────────────────────────────────────────────────────────────────────────────────────── */

describe("reading rules out of a passage", () => {
  const units = parseUnits(LOV);
  const p = passagesFor(LOV, units, 400).find((x) => x.tops.includes("§ 3"))!;
  it("cuts passages along whole §§", () => {
    expect(p.text.startsWith("§ 3.")).toBe(true);
    expect(p.units.map((u) => u.key)).toContain("§ 3, stk. 2, nr. 1, litra a");
  });
  it("keeps only rules whose quote is in the text word for word, with their unit and confidence", () => {
    const a = parseReading({
      rules: [
        { unit: "§ 3", ref: "§ 3", title: "Ryddelige fællesarealer", text: "Beboere skal holde fællesarealer ryddelige.", modality: "skal", quote: "En beboer skal holde fællesarealer ryddelige", confidence: 0.9 },
        { unit: "§ 3 stk 2", ref: "§ 3, stk. 2", title: "Skriftlige klager", text: "Klager over støj skal være skriftlige inden 14 dage.", modality: "must", quote: "Klager over støj skal indgives skriftligt inden for 14 dage.", confidence: 0.4 },
        { unit: "§ 3", ref: "§ 3", title: "Opfundet", text: "Beboere må ikke holde hund.", modality: "must_not", quote: "Beboere må ikke holde hund i opgangen." },
      ],
      definitions: [{ unit: "§ 3", term: "Fællesareal", text: "et område", quote: "ikke i teksten overhovedet" }],
    }, p.text, p.units, { binding: "mandatory" });
    expect(a.rules.map((r) => [r.unit, r.modality, r.confidence])).toEqual([["§ 3", "must", 0.9], ["§ 3, stk. 2", "must", 0.4]]);
    expect(a.dropped.map((d) => d.why)).toEqual(["quote not in the text", "quote not in the text"]);
  });
  it("reads an answer cut off by the token limit", () => {
    expect(jsonOf('{"rules":[{"ref":"§ 1"},{"ref":"§ 2","te')).toEqual({ rules: [{ ref: "§ 1" }] });
    expect(parseUnderstanding({ chapters: [{ chapter: "Kapitel 2", summary: "Hold trappen fri." }], overall: "Kort.", open_questions: ["Gælder det også gæster?"] })).toEqual({ chapters: [{ chapter: "Kapitel 2", summary: "Hold trappen fri." }], overall: "Kort.", openQuestions: ["Gælder det også gæster?"] });
  });
});

describe("coverage and completeness", () => {
  const units = parseUnits(LOV);
  const cu = units.map((u) => ({ ...u, note: accountFor(u) }));
  it("accounts for headings, commencement and repeal without a model", () => {
    expect(cu.find((u) => u.key === "§ 5")!.note).toBe("commencement");
    expect(cu.find((u) => u.key === "§ 5, stk. 2")!.note).toBe("repeal");
    expect(cu.find((u) => u.key === "Kapitel 1")!.note).toBe("heading");
    expect(cu.find((u) => u.key === "§ 3")!.note).toBeNull();
  });
  it("reports every unit and what is still open, then all accounted for", () => {
    const rules = [
      { unitKey: "§ 1", kind: "rule", status: "proposed", confidence: 0.9 },
      { unitKey: "§ 3", kind: "rule", status: "active", confidence: 0.9 },
      { unitKey: "§ 2, nr. 1", kind: "definition", status: "proposed", confidence: null },
    ];
    const r1 = coverageOf(cu, rules);
    expect(r1.units).toBe(units.length);
    expect(r1.open).toEqual(expect.arrayContaining(["§ 1, stk. 2", "§ 2, nr. 2", "§ 3, stk. 2", "§ 4"]));
    expect(r1.allAccounted).toBe(false);
    expect(r1.flagged.penalty).toEqual({ units: 1, covered: 0 });
    expect(rereadList(cu, rules)).toEqual(expect.arrayContaining(["§ 3", "§ 4", "§ 2", "§ 1"]));
    // A rule on a stykke covers its numbers and letters; a § whose parts are all covered is covered.
    const more = [...rules,
      { unitKey: "§ 1, stk. 2", kind: "rule", status: "proposed", confidence: 0.8 }, { unitKey: "§ 2, nr. 2", kind: "definition", status: "proposed", confidence: null },
      { unitKey: "§ 3, stk. 2", kind: "rule", status: "proposed", confidence: 0.3 }, { unitKey: "§ 4", kind: "rule", status: "proposed", confidence: 0.9 }];
    const states = unitStates(cu, more);
    expect(states.get("§ 3, stk. 2, nr. 1, litra a")).toBe("ruled");
    const r2 = coverageOf(cu, more);
    expect(r2.open).toEqual([]);
    expect(r2.allAccounted).toBe(true);
    expect(r2.lowConfidence).toBe(1);
    expect(r2.noRule).toEqual({ commencement: 1, repeal: 1 });
    expect(r2.withRules + r2.definitions + r2.headings + r2.context + Object.values(r2.noRule).reduce((a, b) => a + b, 0)).toBe(r2.units);
  });
});

describe("the official PDF, guidance, and checking for changes", () => {
  it("finds the PDF page of a passage despite line breaks and hyphenation", () => {
    const pages = ["Forside", "§ 3. En beboer skal holde fælles-\nare­aler ryddelige og må ikke stille cykler på trappen.", "§ 4."];
    expect(pageOf(pages, "§ 3. En beboer skal holde fællesarealer ryddelige og må ikke stille cykler på trappen.")).toBe(2);
    expect(pageOf(pages, "Noget helt andet, som ikke står her")).toBeNull();
  });
  it("attaches guidance passages to the § they talk about", () => {
    const links = interpretationLinks([{ id: "c1", sourceId: "g", text: "Efter lovens § 3 skal trappen være fri. Det gælder også barnevogne." }, { id: "c2", sourceId: "g", text: "Om § 99." }], new Set(["§ 3", "§ 4"]), "dk");
    expect([...links.keys()]).toEqual(["§ 3"]);
    expect(links.get("§ 3")![0]).toMatchObject({ chunkId: "c1", quote: expect.stringContaining("§ 3 skal trappen være fri") });
  });
  it("diffs a new version unit by unit: added, changed, removed, unchanged", () => {
    const before = parseUnits(LOV);
    const after = parseUnits(LOV.replace("inden for 14 dage", "inden for 30 dage").replace(/\n\n§ 4\.[^\n]*/, "") + "\n\n§ 6. Foreningen skal have en husorden.");
    const d = diffUnits(before, after);
    expect(d.changed.map((c) => c.to.key)).toEqual(expect.arrayContaining(["§ 3", "§ 3, stk. 2"]));
    expect(d.removed.map((u) => u.key)).toEqual(["§ 4"]);
    expect(d.added.map((u) => u.key)).toEqual(["§ 6"]);
    expect(d.unchanged.map((u) => u.key)).toContain("§ 1");
    expect(topsToReread(d).sort()).toEqual(["§ 3", "§ 6"]);
  });
});
