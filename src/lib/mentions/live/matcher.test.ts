import { describe, expect, it } from "vitest";
import { buildMatcher, foldText, type LexEntry } from "./matcher";

const E = (id: string, label: string, type = "person", extra: Partial<LexEntry> = {}): LexEntry => ({ id, label, type, ...extra });
const lex = [
  E("emma", "Emma"), E("sofie", "Sofie Lund"), E("sofie-only", "Sofie"), E("lund", "Lund", "place"),
  E("pool", "Bellahøj Pool", "place"), E("oak", "Oakwood School", "organization"), E("mette", "Dr. Mette Lund"),
  E("rad", "radiator", "thing"), E("bo", "Bo"), E("mikkel", "Mikkel"), E("aa", "Århus", "place", { aliases: ["Aarhus"] }),
  E("me", "Anna", "person", { self: true }), E("zoo", "Zoo", "place"),
];
const m = buildMatcher(lex);
const ids = (text: string) => m.match(text).map((x) => `${x.entry.id}:${x.text}`);

describe("live matcher", () => {
  it("finds whole names, longest first, without overlaps", () => {
    expect(ids("Sofie Lund and Sofie went to Lund.")).toEqual(["sofie:Sofie Lund", "sofie-only:Sofie", "lund:Lund"]);
  });
  it("needs word boundaries", () => {
    expect(ids("Emmanuel and Lunde")).toEqual([]);
    expect(ids("(Emma)")).toEqual(["emma:Emma"]);
  });
  it("ignores case and diacritics", () => {
    expect(ids("we swam in bellahoj pool")).toEqual(["pool:bellahoj pool"]);
    expect(ids("BELLAHØJ POOL")).toEqual(["pool:BELLAHØJ POOL"]);
    expect(ids("vi bor i Arhus")).toEqual(["aa:Arhus"]);
  });
  it("tolerates extra spaces inside a name", () => {
    expect(ids("Sofie  Lund came")).toEqual(["sofie:Sofie  Lund"]);
  });
  it("takes the Danish genitive -s and English 's", () => {
    expect(ids("Emmas cykel og Sofie Lunds mor")).toEqual(["emma:Emmas", "sofie:Sofie Lunds"]);
    expect(ids("Mikkel's new colleague")).toEqual(["mikkel:Mikkel"]);
  });
  it("takes definite and plural endings on lowercase things only", () => {
    expect(ids("radiatoren og radiatorerne")).toEqual(["rad:radiatoren", "rad:radiatorerne"]);
    expect(ids("Emmaen")).toEqual([]);
  });
  it("matches a titled name with or without the title", () => {
    expect(ids("Dr. Mette Lund called")).toEqual(["mette:Dr. Mette Lund"]);
    expect(ids("Mette Lund called")).toEqual(["mette:Mette Lund"]);
  });
  it("needs the same case for two-letter names", () => {
    expect(ids("Bo kommer")).toEqual(["bo:Bo"]);
    expect(ids("vi bo her")).toEqual([]);
  });
  it("keeps the viewer's own node (marked self) for the caller to drop", () => {
    expect(m.match("Anna and Emma").map((x) => !!x.entry.self)).toEqual([true, false]);
  });
  it("maps offsets back to the original text through folding", () => {
    const text = "Æble og  Bellahøj Pool";
    const [hit] = m.match(text);
    expect(text.slice(hit.start, hit.end)).toBe("Bellahøj Pool");
    expect(foldText("Æb").s).toBe("aeb");
  });
  it("is fast on a big lexicon (5,000 labels, 2,000 characters < 8 ms per match)", () => {
    const first = ["Anna", "Bo", "Carl", "Dorte", "Emil", "Freja", "Gustav", "Hanne", "Ida", "Jens", "Karen", "Lars", "Mads", "Nina", "Ole", "Pia"];
    const last = ["Hansen", "Jensen", "Nielsen", "Pedersen", "Andersen", "Christensen", "Larsen", "Sørensen", "Rasmussen", "Jørgensen"];
    const big: LexEntry[] = [];
    for (let i = 0; i < 5000; i++) big.push(E(`p${i}`, `${first[i % first.length]} ${last[(i >> 4) % last.length]} ${i}`, i % 3 ? "person" : "thing"));
    for (let i = 0; i < 200; i++) big.push(E(`t${i}`, `topic${i}`, "topic"));
    const t0 = performance.now();
    const bm = buildMatcher(big);
    const buildMs = performance.now() - t0;
    const words = "Anna Hansen 12 mødtes med Lars Larsen 300 og topic42 i går ved søen, og radiatoren larmer igen. ";
    const text = words.repeat(Math.ceil(2000 / words.length)).slice(0, 2000);
    bm.match(text); // warm up
    const runs = 20;
    const t1 = performance.now();
    let hits = 0;
    for (let i = 0; i < runs; i++) hits = bm.match(text).length;
    const perMatch = (performance.now() - t1) / runs;
    expect(hits).toBeGreaterThan(20);
    expect(perMatch).toBeLessThan(8);
    expect(buildMs).toBeLessThan(500);
  });
});
