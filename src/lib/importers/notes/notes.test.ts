import { describe, expect, it } from "vitest";
import type { ChangeInput } from "@/lib/changes";
import type { ImportContext, ImportKnown } from "../types";
import { appleNotesImporter } from "./apple-notes";
import { namesIn, nameCandidates, parseDay, splitFrontmatter } from "./common";
import { cleanPath, notionImporter, parseCsv } from "./notion";
import { inlineTags, obsidianImporter, wikilinks } from "./obsidian";

const enc = (s: string) => new TextEncoder().encode(s);
const buf = (s: string) => Buffer.from(s, "utf-8");

function ctx(known: ImportKnown[] = [], existingEdges: string[] = []): ImportContext {
  let n = 0;
  return {
    sourceId: "src-9", graphKind: "family", visibility: "parents", known, existingEdges: new Set(existingEdges), now: new Date("2024-06-01T00:00:00Z"),
    mint: () => `id-${++n}`, locale: "en",
  };
}
const node = (id: string, type: string, label: string, props: Record<string, unknown> = {}, aliases: string[] = []): ImportKnown =>
  ({ id, type, kind: null, label, aliases, startAt: null, props });
const of = <K extends ChangeInput["op"]>(cs: ChangeInput[], op: K) => cs.filter((c) => c.op === op) as Extract<ChangeInput, { op: K }>[];

const KNOWN = [
  node("p-ida", "person", "Ida Holm", { birthday: "2016-04-02" }, ["Ida"]),
  node("p-karen", "person", "Karen Holm", {}, ["Mormor"]),
  node("p-ida2", "person", "Ida Lund"),
  node("p-mor", "person", "Mor"),
];

describe("notes helpers", () => {
  it("parses frontmatter lists, inline lists and quotes", () => {
    const { fm, body } = splitFrontmatter("---\ntype: person\naliases: [Mormor, \"Karen H.\"]\ntags:\n  - familie\n  - bedsteforældre\nfødselsdag: 2. maj 1948\n---\n# Karen\nTekst");
    expect(fm.type).toBe("person");
    expect(fm.aliases).toEqual(["Mormor", "Karen H."]);
    expect(fm.tags).toEqual(["familie", "bedsteforældre"]);
    expect(fm["fødselsdag"]).toBe("2. maj 1948");
    expect(body).toBe("# Karen\nTekst");
  });

  it("reads the dates people write", () => {
    expect(parseDay("2. maj 1948")).toBe("1948-05-02");
    expect(parseDay("May 2, 1948")).toBe("1948-05-02");
    expect(parseDay("02/05/1948")).toBe("1948-05-02");
    expect(parseDay("1948-05-02")).toBe("1948-05-02");
    expect(parseDay("soon")).toBeNull();
  });

  it("finds only unambiguous names, longest first, case as written", () => {
    const c = nameCandidates(KNOWN);
    // "Ida" is an alias of one person only; "Ida Holm" wins where it is written in full.
    const hits = namesIn("Ida Holm og Mormor kommer. Ida Lund også. mor er træt.", c);
    expect([...hits.keys()].sort()).toEqual(["p-ida", "p-ida2", "p-karen"]);
    // "Mor" is matched only when written as the name, not the word "mor".
    expect(namesIn("Mor ringede", c).has("p-mor")).toBe(true);
    expect(namesIn("min mor ringede", c).has("p-mor")).toBe(false);
  });
});

/* ── Apple Notes ───────────────────────────────────────────────────────────────────────────────────────────── */

describe("apple_notes", () => {
  const payload = {
    notes: [
      { id: "x-coredata://1", title: "Påske hos Mormor", folder: "Familie", createdAt: "2024-03-01T10:00:00Z", text: "Vi kører torsdag.\nMormor vil have Ida Holm til at bage." },
      { id: "x-coredata://2", title: "Indkøb", text: "mælk, brød, kaffe" },
      { id: "x-coredata://3", title: "WiFi", text: "Netværk: Holm5G" },
    ],
  };

  it("one segment per note, a document linked to each named person, receipts with the line", async () => {
    const plan = await appleNotesImporter.read({ filename: "Apple Notes", bytes: buf(JSON.stringify(appleNotesImporter.json!.parse(payload))) }, ctx(KNOWN));
    expect(plan.segments).toHaveLength(3);
    expect(plan.segments[0].at?.region).toBe("Familie / Påske hos Mormor");
    const docs = of(plan.changes, "addNode");
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ type: "document", label: "Påske hos Mormor", props: { appleNoteId: "x-coredata://1" }, visibility: "parents" });
    const edges = of(plan.changes, "addEdge");
    expect(edges.map((e) => e.toId).sort()).toEqual(["p-ida", "p-karen"]);
    expect(edges.every((e) => e.relation === "mentions" && e.fromId === docs[0].nodeId)).toBe(true);
    expect(edges.find((e) => e.toId === "p-ida")!.receipt?.quote).toBe("Mormor vil have Ida Holm til at bage.");
    expect(plan.extract).toBe(true);
    expect(appleNotesImporter.sensitive).toBeUndefined();
  });

  it("a note imported before reuses its document and adds only missing links", async () => {
    const known = [...KNOWN, node("d-1", "document", "Påske hos Mormor", { appleNoteId: "x-coredata://1" })];
    const plan = await appleNotesImporter.read({ filename: "Apple Notes", bytes: buf(JSON.stringify(payload)) }, ctx(known, ["d-1|mentions|p-karen"]));
    expect(of(plan.changes, "addNode")).toHaveLength(0);
    expect(of(plan.changes, "addEdge").map((e) => [e.fromId, e.toId])).toEqual([["d-1", "p-ida"]]);
  });
});

/* ── Obsidian ──────────────────────────────────────────────────────────────────────────────────────────────── */

const VAULT: Record<string, string> = {
  "Familie/.obsidian/app.json": "{}",
  "Familie/.obsidian/workspace.json": "{}",
  "Familie/People/Karen Holm.md": "---\ntype: person\naliases: [Mormor]\nphone: +45 40 11 22 33\nbirthday: 1948-05-02\n---\n# Karen Holm\nBor i Silkeborg. #familie",
  "Familie/People/Jonas Berg.md": "---\ntags: [person, fodbold]\nemail: jonas@example.dk\n---\nTræner U10 sammen med [[Ida Holm|Ida]]s far.",
  "Familie/Ida Holm.md": "Går i 2.B på Valby Skole.",
  "Familie/Daily/2024-03-12.md": "Hentede Ida. Snakkede med [[Jonas Berg]] om kampen lørdag. #fodbold\n```\n#notatag\n```\nFarve #fff",
  "Familie/Daily/2024-03-13.md": "Regn hele dagen.",
  "Familie/Opskrifter/Boller.md": "# Boller\n- mel\n- gær",
  "Familie/billeder/kage.jpg": "",
};

describe("obsidian", () => {
  it("claims a vault, not a zip of documents, emails, or a Notion export", () => {
    expect(obsidianImporter.detectArchive!({ filename: "Familie.zip", names: Object.keys(VAULT) })).toBe(true);
    expect(obsidianImporter.detectArchive!({ filename: "x.zip", names: ["2024-03-12.md", "a.md", "b.md", "pic.png"] })).toBe(true);
    expect(obsidianImporter.detectArchive!({ filename: "docs.zip", names: ["a.md", "b.md", "c.md"] })).toBe(false); // no daily notes, no .obsidian
    expect(obsidianImporter.detectArchive!({ filename: "docs.zip", names: ["2024-03-12.md", "a.md", "b.md", "report.docx"] })).toBe(false);
    expect(obsidianImporter.detectArchive!({ filename: "mails.zip", names: ["a.eml", "b.eml"] })).toBe(false);
    expect(obsidianImporter.detectArchive!({ filename: "Export.zip", names: ["Hjem 0123456789abcdef0123456789abcdef.md", "2024-03-12 89abcdef0123456789abcdef01234567.md", "x 11111111111111111111111111111111.md"] })).toBe(false);
  });

  it("reads links and tags", () => {
    expect(wikilinks("[[Ida Holm|Ida]] og [[Daily/2024-03-12#Morgen]] ![[kage.jpg]] ![[Boller]]").sort()).toEqual(["2024-03-12", "Boller", "Ida Holm"]);
    expect(inlineTags("# Heading\n#familie og #fodbold/u10 `#kode` #fff")).toEqual(["familie", "fodbold/u10"]);
  });

  it("plans: notes as segments, person notes matched or proposed, links to people from notes", async () => {
    const entries = Object.entries(VAULT).filter(([n]) => obsidianImporter.acceptEntry!(n)).map(([name, s]) => ({ name, bytes: enc(s) }));
    expect(entries).toHaveLength(6);
    const known = [node("p-ida", "person", "Ida Holm"), node("p-karen", "person", "Karen Holm", { phone: "+45 99 99 99 99" })];
    const plan = await obsidianImporter.read({ filename: "Familie.zip", bytes: Buffer.alloc(0), entries }, ctx(known));
    expect(plan.segments).toHaveLength(6);
    const daily = plan.segments.find((s) => s.at?.region === "Daily / 2024-03-12")!;
    expect(daily.text).toContain("Day: 2024-03-12");
    expect(daily.text).toContain("Tags: #fodbold\n");

    const people = of(plan.changes, "addNode").filter((c) => c.type === "person");
    expect(people.map((p) => p.label)).toEqual(["Jonas Berg"]);
    expect(people[0].props).toEqual({ email: "jonas@example.dk" });
    // Karen is known: she gains the alias and birthday, never a changed phone.
    const karen = of(plan.changes, "updateNode").find((u) => u.nodeId === "p-karen")!;
    expect(karen.set).toEqual({ props: { birthday: "1948-05-02" }, aliases: ["Mormor"] });

    const docs = of(plan.changes, "addNode").filter((c) => c.type === "document");
    const dailyDoc = docs.find((d) => d.label === "2024-03-12")!;
    expect(dailyDoc.startAt).toBe("2024-03-12T12:00:00.000Z");
    const edges = of(plan.changes, "addEdge").filter((e) => e.fromId === dailyDoc.nodeId);
    // "Ida" alone isn't a name the graph knows; [[Jonas Berg]] is a link to a person's note.
    expect(edges.map((e) => e.toId)).toEqual([people[0].nodeId]);
    const jonasDoc = docs.find((d) => d.label === "Jonas Berg")!;
    expect(of(plan.changes, "addEdge").filter((e) => e.fromId === jonasDoc.nodeId).map((e) => e.toId)).toEqual(["p-ida"]);
    expect(plan.counts["daily notes"]).toBe(2);
    expect(plan.title).toBe("Obsidian vault “Familie”: 6 notes");
    expect(plan.extract).toBe(true);
  });
});

/* ── Notion ────────────────────────────────────────────────────────────────────────────────────────────────── */

const H1 = "0123456789abcdef0123456789abcdef";
const H2 = "89abcdef0123456789abcdef01234567";
const H3 = "11111111111111111111111111111111";
const H4 = "22222222222222222222222222222222";
const NOTION: Record<string, string> = {
  [`Familie ${H1}.md`]: `# Familie\n\n[Kontakter](Familie%20${H1}/Kontakter%20${H2}.csv)\n[Sommerferie 2024](Familie%20${H1}/Sommerferie%202024%20${H3}.md)`,
  [`Familie ${H1}/Sommerferie 2024 ${H3}.md`]: `# Sommerferie 2024\n\nVi lejer hus i Skagen 6.–20. juli. [Anders Lund](Kontakter%20${H2}/Anders%20Lund%20${H4}.md) kommer den 10.\nIda Holm skal have badetøj.`,
  [`Familie ${H1}/Kontakter ${H2}.csv`]: "Name,Email,Phone\nAnders Lund,anders@example.dk,\n",
  [`Familie ${H1}/Kontakter ${H2}_all.csv`]: "﻿Name,Email,Telefon,Fødselsdag,Noter\nAnders Lund,anders@example.dk,+45 20 30 40 50,\"March 3, 1980\",\"Gammel ven, fra gymnasiet\"\nIda Holm,,,\"April 2, 2016\",\n",
  [`Familie ${H1}/Kontakter ${H2}/Anders Lund ${H4}.md`]: "# Anders Lund\n\nEmail: anders@example.dk\n\nGammel ven fra gymnasiet.",
  [`Familie ${H1}/Opgaver ${H1.replace(/0/g, "9")}.csv`]: "Opgave,Status,Dato\nBestil færge,Done,2024-05-01\n\"Pak, tøj\",Todo,\n",
};

describe("notion_export", () => {
  it("claims Notion's zip only", () => {
    expect(notionImporter.detectArchive!({ filename: "Export-abc.zip", names: Object.keys(NOTION) })).toBe(true);
    expect(notionImporter.detectArchive!({ filename: "notes.zip", names: ["a.md", "b.md"] })).toBe(false);
    expect(notionImporter.detectArchive!({ filename: "Export-abc.zip", names: ["Export-abc-Part-1.zip"] })).toBe(false);
  });

  it("cleans ids from paths and parses CSV", () => {
    expect(cleanPath(`Familie ${H1}/Kontakter ${H2}_all.csv`)).toBe("Familie/Kontakter");
    expect(parseCsv('a,b\n"x, y","he said ""hi"""\n')).toEqual([["a", "b"], ["x, y", 'he said "hi"']]);
  });

  it("plans: pages and rows as segments, a contacts database gives people, links from pages", async () => {
    const entries = Object.entries(NOTION).map(([name, s]) => ({ name, bytes: enc(s) }));
    const known = [node("p-ida", "person", "Ida Holm", { birthday: "2016-04-02" })];
    const plan = await notionImporter.read({ filename: "Export-abc.zip", bytes: Buffer.alloc(0), entries }, ctx(known));
    // 3 pages + 2 databases (the _all.csv replaces the view).
    expect(plan.segments).toHaveLength(5);
    expect(plan.segments.some((s) => s.at?.region === "Familie / Sommerferie 2024")).toBe(true);
    const rows = plan.segments.find((s) => s.text.startsWith("Database: Opgaver"))!;
    expect(rows.text).toContain("- Pak, tøj — Status: Todo");
    const people = of(plan.changes, "addNode").filter((c) => c.type === "person");
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({ label: "Anders Lund", props: { email: "anders@example.dk", phone: "+45 20 30 40 50", birthday: "1980-03-03" } });
    expect(plan.counts["people already known"]).toBe(1);
    const trip = of(plan.changes, "addNode").find((c) => c.type === "document" && c.label === "Sommerferie 2024")!;
    expect(trip.props).toMatchObject({ notionId: H3 });
    const edges = of(plan.changes, "addEdge").filter((e) => e.fromId === trip.nodeId);
    expect(edges.map((e) => e.toId).sort()).toEqual([people[0].nodeId, "p-ida"].sort());
    // Anders' own page doesn't "mention" him.
    expect(of(plan.changes, "addNode").some((c) => c.type === "document" && c.label === "Anders Lund")).toBe(false);
    expect(plan.title).toBe("Notion “Familie”: 3 pages");
  });
});
