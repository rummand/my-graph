import { describe, expect, it } from "vitest";
import type { ChangeInput } from "@/lib/changes";
import { edgeKey } from "../match";
import type { ImportContext, ImportKnown, ImportPlan } from "../types";
import { exactDay, formatDate, parseDate } from "./dates";
import { decodeAnsel, decodeGedcom } from "./decode";
import { gedcomImporter, looksLikeGedcom } from "./index";
import { parseGedcom } from "./parse";
import { MAX_OPS } from "./plan";

const FAMILY = `0 HEAD
1 SOUR MYHERITAGE
2 NAME MyHeritage Family Tree Builder
1 GEDC
2 VERS 5.5.1
2 FORM LINEAGE-LINKED
1 CHAR UTF-8
1 DATE 2 NOV 2026
0 @I1@ INDI
1 NAME Mette /Sørensen/
1 SEX F
1 BIRT
2 DATE 12 APR 1985
2 PLAC Aarhus, Danmark
1 _UID 1A2B3C
1 FAMC @F2@
0 @I2@ INDI
1 NAME Jens /Sørensen/
1 SEX M
1 BIRT
2 DATE 12. maj 1955
2 PLAC Århus, Danmark
1 OCCU Tømrer
1 FAMS @F2@
1 FAMC @F1@
0 @I3@ INDI
1 NAME Karen /Nielsen/
2 _MARNM Sørensen
1 SEX F
1 BIRT
2 DATE ABT 1957
1 FAMS @F2@
0 @I4@ INDI
1 NAME Peder /SØRENSEN/
1 SEX M
1 BIRT
2 DATE 3 MAR 1921
2 PLAC Vejle, Vejle Amt, Danmark
2 SOUR @S1@
3 PAGE Opslag 112
1 DEAT
2 DATE 14 OKT 1998
2 PLAC Aarhus, Danmark
1 FAMS @F1@
1 FAMC @F3@
0 @I5@ INDI
1 NAME Anna Margrethe /Jensen/
2 _MARNM Sørensen
1 SEX F
1 BIRT
2 DATE BET 1922 AND 1924
2 PLAC Jelling
1 DEAT
2 DATE 2001
1 FAMS @F1@
0 @I6@ INDI
1 NAME Søren /Pedersen/
1 SEX M
1 BIRT
2 DATE 1890
1 DEAT
2 DATE AFT 1950
1 NOTE Søren var husmand i Jelling og havde
2 CONC  en lille gård.
2 CONT Han flyttede til Vejle i 1920.
1 SOUR @S1@
1 FAMS @F3@
0 @I7@ INDI
1 NAME Living /Sørensen/
1 FAMC @F2@
0 @I8@ INDI
1 NAME Hans /Hansen/
1 SEX M
1 BIRT
2 DATE 1970
0 @I9@ INDI
1 NAME Ida /Sørensen/
1 RESN privacy
1 SEX F
1 BIRT
2 DATE 4 JUL 2015
2 PLAC Aarhus
1 FAMC @F4@
0 @F1@ FAM
1 HUSB @I4@
1 WIFE @I5@
1 CHIL @I2@
1 MARR
2 DATE 20 JUN 1948
2 PLAC Vejle, Vejle Amt, Danmark
0 @F2@ FAM
1 HUSB @I2@
1 WIFE @I3@
1 CHIL @I1@
1 CHIL @I7@
1 MARR
2 DATE 12 JUN 1982
2 PLAC Vejle Kirke
0 @F3@ FAM
1 HUSB @I6@
1 CHIL @I4@
0 @F4@ FAM
1 WIFE @I1@
1 CHIL @I9@
0 @S1@ SOUR
1 TITL Kirkebog for Vejle Sogn 1915-1925
0 TRLR
`;

const known = (p: Partial<ImportKnown> & { id: string; label: string }): ImportKnown => ({
  type: "person", kind: null, aliases: [], startAt: null, props: {}, ...p,
});

function ctxOf(k: ImportKnown[], edges: string[] = []): ImportContext {
  let n = 0;
  return {
    sourceId: "src-1", graphKind: "family", visibility: "household", known: k, existingEdges: new Set(edges),
    now: new Date("2026-11-05T12:00:00Z"), mint: () => `new-${++n}`, locale: "da",
  };
}

const enc = (s: string) => new TextEncoder().encode(s);
const run = (text: string | Uint8Array, ctx: ImportContext, filename = "tree.ged") =>
  gedcomImporter.read({ filename, bytes: Buffer.from(typeof text === "string" ? enc(text) : text) }, ctx) as ImportPlan;

const adds = (p: ImportPlan, type: string) => p.changes.filter((c): c is Extract<ChangeInput, { op: "addNode" }> => c.op === "addNode" && c.type === type);
const edges = (p: ImportPlan, rel: string) => p.changes.filter((c): c is Extract<ChangeInput, { op: "addEdge" }> => c.op === "addEdge" && c.relation === rel);

describe("gedcom decode", () => {
  it("reads ANSEL with Danish letters", () => {
    // S ø r e n   +   ring above before a = å   +   Æ
    expect(decodeAnsel(new Uint8Array([0x53, 0xb2, 0x72, 0x65, 0x6e, 0x20, 0xea, 0x61, 0x20, 0xa5, 0x72, 0xb8]))).toBe("Søren å Ærı");
    const file = new Uint8Array([...enc("0 HEAD\n1 CHAR ANSEL\n0 @I1@ INDI\n1 NAME S"), 0xb2, ...enc("ren /Kj"), 0xe8, 0x61, ...enc("r/\n")]);
    expect(decodeGedcom(file)).toMatchObject({ encoding: "ansel" });
    expect(parseGedcom(decodeGedcom(file).text).indis[0].names[0].full).toBe("Søren Kjär");
  });

  it("reads UTF-16 with a BOM, UTF-8 with a BOM, and falls back to Windows-1252", () => {
    const s = "0 HEAD\n1 GEDC\n2 VERS 5.5\n0 @I1@ INDI\n1 NAME Bodil /Ærø/\n";
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, "utf16le")]);
    expect(decodeGedcom(le)).toMatchObject({ encoding: "utf-16le", bom: true, text: s });
    expect(decodeGedcom(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(s)]))).toMatchObject({ encoding: "utf-8", text: s });
    expect(decodeGedcom(Buffer.from(s, "latin1"))).toMatchObject({ encoding: "windows-1252", text: s });
    expect(looksLikeGedcom("export.txt", le)).toBe(true);
  });
});

describe("gedcom dates", () => {
  it("understands qualifiers, ranges, dual dates and Danish months", () => {
    expect(parseDate("3 MAR 1921")).toMatchObject({ qual: "exact", a: { y: 1921, m: 3, d: 3 } });
    expect(exactDay(parseDate("12. maj 1955"))).toBe("1955-05-12");
    expect(exactDay(parseDate("14 OKT 1998"))).toBe("1998-10-14");
    expect(exactDay(parseDate("03.03.1921"))).toBe("1921-03-03");
    expect(exactDay(parseDate("@#DJULIAN@ 1 JAN 1700"))).toBe("1700-01-01");
    expect(parseDate("ABT 1850")).toMatchObject({ qual: "about", a: { y: 1850 } });
    expect(parseDate("ca. 1850")).toMatchObject({ qual: "about", a: { y: 1850 } });
    expect(parseDate("før 1900")).toMatchObject({ qual: "before" });
    expect(parseDate("mellem 1850 og 1860")).toMatchObject({ qual: "between", a: { y: 1850 }, b: { y: 1860 } });
    expect(parseDate("FROM 1940 TO 1945")).toMatchObject({ qual: "range" });
    expect(parseDate("11 FEB 1720/21")).toMatchObject({ a: { y: 1721, m: 2, d: 11 } });
    expect(parseDate("1699/00").a?.y).toBe(1700);
    expect(parseDate("INT 1850 (about the time of the fire)")).toMatchObject({ qual: "exact", a: { y: 1850 } });
    expect(parseDate("(sometime in spring)").qual).toBe("phrase");
    expect(parseDate("31 FEB 1900").qual).toBe("phrase");
    expect(formatDate(parseDate("BET 1922 AND 1924"))).toBe("between 1922 and 1924");
    expect(formatDate(parseDate("MAR 1921"))).toBe("Mar 1921");
  });
});

describe("gedcom detection", () => {
  it("is certain", () => {
    expect(gedcomImporter.detect({ filename: "tree.ged", head: enc(FAMILY.slice(0, 200)) })).toBe(true);
    expect(gedcomImporter.detect({ filename: "upload.bin", head: enc(FAMILY.slice(0, 200)) })).toBe(true);
    expect(gedcomImporter.detect({ filename: "notes.txt", head: enc("0 HEAD is how a GEDCOM starts\n1 GEDC") })).toBe(false);
    expect(gedcomImporter.detect({ filename: "tree.ged", head: enc("hello") })).toBe(false);
    expect(gedcomImporter.detectArchive!({ filename: "x.zip", names: ["tree/family.ged", "tree/media/a.jpg"] })).toBe(true);
    expect(gedcomImporter.detectArchive!({ filename: "x.zip", names: ["docs/a.docx", "family.ged"] })).toBe(false);
    expect(gedcomImporter.acceptEntry!("__MACOSX/._family.ged")).toBe(false);
  });
});

describe("gedcom parse", () => {
  it("reads names, notes with CONT/CONC, sources and families", () => {
    const f = parseGedcom(FAMILY);
    expect(f.header).toMatchObject({ version: "5.5.1", product: "MyHeritage Family Tree Builder" });
    const peder = f.indis.find((i) => i.xref === "@I4@")!;
    expect(peder.names[0]).toMatchObject({ full: "Peder Sørensen", surname: "Sørensen" });
    expect(peder.events[0].sources[0]).toBe("Kirkebog for Vejle Sogn 1915-1925, Opslag 112");
    const soren = f.indis.find((i) => i.xref === "@I6@")!;
    expect(soren.notes[0]).toBe("Søren var husmand i Jelling og havde en lille gård.\nHan flyttede til Vejle i 1920.");
    expect(f.indis.find((i) => i.xref === "@I5@")!.names[0].married).toEqual(["Sørensen"]);
    expect(f.fams.find((x) => x.xref === "@F2@")!.children.map((c) => c.indi)).toEqual(["@I1@", "@I7@"]);
  });

  it("reads GEDCOM 7", () => {
    const g7 = "0 HEAD\n1 GEDC\n2 VERS 7.0\n0 @I1@ INDI\n1 NAME Ole /Bak/\n1 BIRT\n2 DATE JULIAN 1 JAN 1700\n0 @F1@ FAM\n1 HUSB @VOID@\n1 CHIL @I1@\n0 TRLR\n";
    const f = parseGedcom(g7);
    expect(f.header.version).toBe("7.0");
    expect(exactDay(f.indis[0].events[0].date)).toBe("1700-01-01");
    expect(f.fams[0].husb).toBeUndefined();
  });
});

describe("gedcom plan", () => {
  const graph = [
    known({ id: "k-mette", label: "Mette Sørensen", props: { birthday: "1985-04-12", email: "mette@example.dk" } }),
    known({ id: "k-jens", label: "Jens Sørensen", props: { birthDate: "1955-05-12", occupation: "Snedker" } }),
    known({ id: "k-hans", label: "Hans Hansen", props: { birthYear: 1960 } }),
    known({ id: "k-vejle", type: "place", label: "Vejle" }),
  ];
  const plan = run(FAMILY, ctxOf(graph, [edgeKey("k-jens", "parent_of", "k-mette")]));
  const text = plan.segments[0].text;

  it("renders one readable line per person and family", () => {
    expect(text).toContain("Family tree (GEDCOM 5.5.1 from MyHeritage Family Tree Builder): 8 people, 4 families.");
    expect(text).toMatch(/Peder Sørensen, male\. Born 3 Mar 1921, Vejle, Vejle Amt, Danmark\. Died 14 Oct 1998, Aarhus, Danmark\./);
    expect(text).toContain("Anna Margrethe Jensen (also Anna Margrethe Sørensen), female. Born between 1922 and 1924, Jelling.");
    expect(text).toContain("Note: Søren var husmand i Jelling og havde en lille gård. Han flyttede til Vejle i 1920.");
    expect(text).toContain("Peder Sørensen and Anna Margrethe Jensen. Married 20 Jun 1948, Vejle, Vejle Amt, Danmark. Children: Jens Sørensen.");
    expect(text).not.toContain("Living Sørensen");
    expect(plan.title).toBe("Family tree: 8 people");
    expect(plan.extract).toBe(false);
  });

  it("matches the people the graph knows and only adds what they lack", () => {
    const upd = plan.changes.filter((c): c is Extract<ChangeInput, { op: "updateNode" }> => c.op === "updateNode");
    const jens = upd.find((c) => c.nodeId === "k-jens")!;
    expect(jens.set.props).toMatchObject({ sex: "male", birthYear: 1955, birthPlace: "Århus, Danmark" });
    expect(jens.set.props).not.toHaveProperty("occupation"); // the graph says Snedker; never overwritten
    expect(jens.set.props).not.toHaveProperty("birthDate");
    expect(jens.set.props).not.toHaveProperty("birthday"); // birthDate already set
    const mette = upd.find((c) => c.nodeId === "k-mette")!;
    expect(mette.set.props).toMatchObject({ birthDate: "1985-04-12", gedcomUid: "1A2B3C" });
    expect(mette.set.props).not.toHaveProperty("birthday");
    expect(adds(plan, "person").map((c) => c.label)).not.toContain("Mette Sørensen");
    expect(plan.counts["known people"]).toBe(2);
  });

  it("never matches on a name alone when the birth year disagrees", () => {
    expect(adds(plan, "person").map((c) => c.label)).toContain("Hans Hansen");
    expect(plan.changes.some((c) => c.op === "updateNode" && c.nodeId === "k-hans")).toBe(false);
  });

  it("proposes parent and partner edges, not those that exist", () => {
    const parents = edges(plan, "parent_of");
    expect(parents.some((e) => e.fromId === "k-jens" && e.toId === "k-mette")).toBe(false);
    const karen = adds(plan, "person").find((c) => c.label === "Karen Nielsen")!;
    expect(parents.some((e) => e.fromId === karen.nodeId && e.toId === "k-mette")).toBe(true);
    const peder = adds(plan, "person").find((c) => c.label === "Peder Sørensen")!;
    expect(parents.some((e) => e.fromId === peder.nodeId && e.toId === "k-jens")).toBe(true);
    const soren = adds(plan, "person").find((c) => c.label === "Søren Pedersen")!;
    expect(parents.some((e) => e.fromId === soren.nodeId && e.toId === peder.nodeId)).toBe(true);
    const partners = edges(plan, "partner_of");
    expect(partners.some((e) => e.fromId === "k-jens" && e.toId === karen.nodeId)).toBe(true);
    expect(partners).toHaveLength(2);
    expect(karen.aliases).toEqual(["Karen Sørensen"]);
    expect(karen.props).toMatchObject({ birthDateText: "about 1957", sex: "female" });
    expect(karen.props).not.toHaveProperty("birthYear");
  });

  it("makes events only for the dead with a date and a place, and deduplicates places", () => {
    const events = adds(plan, "event").map((e) => e.label).sort();
    expect(events).toEqual(["Birth of Peder Sørensen", "Death of Peder Sørensen", "Marriage of Peder Sørensen and Anna Margrethe Jensen"]);
    const birth = adds(plan, "event").find((e) => e.label === "Birth of Peder Sørensen")!;
    expect(birth.startAt).toBe("1921-03-03");
    const places = adds(plan, "place");
    // Vejle matched the known place by its first part (birth and marriage); Aarhus is new.
    expect(places.map((p) => p.label)).toEqual(["Aarhus, Danmark"]);
    const at = edges(plan, "happened_at");
    expect(at.filter((e) => e.toId === "k-vejle")).toHaveLength(2);
    expect(edges(plan, "involves").filter((e) => e.fromId === birth.nodeId).map((e) => e.toId)).toHaveLength(1);
  });

  it("keeps living people to what the file holds, and private ones to a name", () => {
    const karen = adds(plan, "person").find((c) => c.label === "Karen Nielsen")!;
    expect(karen.note).toMatch(/Living as far as the file shows/);
    expect(karen.visibility).toBe("household");
    const ida = adds(plan, "person").find((c) => c.label === "Ida Sørensen")!;
    expect(ida.visibility).toBe("private");
    expect(ida.props).toEqual({ gedcomId: "@I9@" });
    expect(ida.summary).toBeUndefined();
    expect(text).toContain("Ida Sørensen, female. Details withheld (privacy).");
    expect(plan.warnings!.join(" ")).toMatch(/1 person was exported as “Living”/);
    const peder = adds(plan, "person").find((c) => c.label === "Peder Sørensen")!;
    expect(peder.props).toMatchObject({ birthDate: "1921-03-03", birthYear: 1921, deathDate: "1998-10-14", deceased: true, gedcomId: "@I4@" });
    expect(peder.props).not.toHaveProperty("birthday");
    const anna = adds(plan, "person").find((c) => c.label === "Anna Margrethe Jensen")!;
    expect(anna.props).toMatchObject({ deathYear: 2001, birthDateText: "between 1922 and 1924" });
  });

  it("points every receipt at the line it quotes", () => {
    for (const c of plan.changes) {
      const r = c.receipt!;
      expect(r.sourceId).toBe("src-1");
      const loc = r.locator as { charStart: number; charEnd: number };
      expect(text.slice(loc.charStart, loc.charEnd)).toBe(r.quote);
    }
    const peder = adds(plan, "person").find((c) => c.label === "Peder Sørensen")!;
    expect(peder.note).toContain("Kirkebog for Vejle Sogn");
  });

  it("reads a .ged inside a zip", () => {
    const p = gedcomImporter.read({ filename: "tree.zip", bytes: Buffer.alloc(0), entries: [{ name: "export/tree.ged", bytes: enc(FAMILY) }] }, ctxOf([])) as ImportPlan;
    expect(p.counts.people).toBe(8);
  });
});

describe("gedcom large trees", () => {
  /** A long line of descent: 3000 people, every generation a couple with one child, plus a sibling each. */
  function bigTree(gens: number): string {
    const out = ["0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8"];
    for (let g = 0; g < gens; g++) {
      const y = 1000 + (g % 30) * 30;
      out.push(`0 @I${g}a@ INDI`, `1 NAME Person${g} /Line/`, "1 SEX M", "1 BIRT", `2 DATE ${y}`, "2 PLAC Ribe", "1 DEAT", `2 DATE ${y + 70}`, "2 PLAC Ribe");
      out.push(`0 @I${g}b@ INDI`, `1 NAME Wife${g} /Other/`, "1 SEX F");
      out.push(`0 @I${g}c@ INDI`, `1 NAME Sibling${g} /Line/`);
    }
    for (let g = 0; g < gens; g++) {
      out.push(`0 @F${g}@ FAM`, `1 HUSB @I${g + 1}a@`, `1 WIFE @I${g + 1}b@`, `1 CHIL @I${g}a@`, `1 CHIL @I${g}c@`);
    }
    return out.join("\n");
  }

  it("stays under the cap, nearest to the known people first, and says what it left out", () => {
    const anchor = known({ id: "k-anchor", label: "Person500 Line", props: { birthYear: 1000 + (500 % 30) * 30 } });
    const p = run(bigTree(1000), ctxOf([anchor]));
    expect(p.changes.length).toBeLessThanOrEqual(MAX_OPS);
    expect(p.counts["left out"]).toBeGreaterThan(0);
    expect(p.counts.people + p.counts["known people"] + p.counts["left out"]).toBe(3000);
    expect(p.warnings!.join(" ")).toMatch(/left out/);
    // The anchor's direct parents and children are in; the far ends of the line are not.
    const labels = new Set(adds(p, "person").map((c) => c.label));
    expect(labels.has("Person501 Line")).toBe(true);
    expect(labels.has("Person499 Line")).toBe(true);
    expect(labels.has("Person0 Line")).toBe(false);
    // Edges only between people in the set.
    const ids = new Set([...adds(p, "person").map((c) => c.nodeId), "k-anchor", ...adds(p, "event").map((c) => c.nodeId), ...adds(p, "place").map((c) => c.nodeId)]);
    for (const e of p.changes.filter((c) => c.op === "addEdge")) {
      expect(ids.has((e as { fromId: string }).fromId) && ids.has((e as { toId: string }).toId)).toBe(true);
    }
  });
});
