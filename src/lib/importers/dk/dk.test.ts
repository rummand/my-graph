import { describe, expect, it } from "vitest";
import type { ChangeInput } from "@/lib/changes";
import { findAuthorities } from "./authorities";
import { copenhagenToIso, findDates } from "./dates";
import { classifyDigitalPostEmail, digitalPostOps } from "./digital-post";
import { readDanishDocument, withDanishOps } from "./document";
import { classifyPublicLetter, publicLetterOps } from "./public-letter";
import { readSundhed, sundhedSections } from "./sundhed";

const NOW = new Date("2026-11-05T10:00:00Z");
let n = 0;
const mint = () => `id-${++n}`;

/* ── Fixtures (written for these tests; shaped like the real emails and printouts) ─────────────────────── */

const EBOKS_EMAIL = {
  from: "e-Boks <noreply@e-boks.dk>",
  subject: "Du har modtaget ny post i e-Boks",
  date: "2026-11-04T07:12:00.000Z",
};
const EBOKS_TEXT = `Subject: Du har modtaget ny post i e-Boks
From: e-Boks <noreply@e-boks.dk>
Date: 2026-11-04T07:12:00.000Z

Kære Anna Hansen

Du har modtaget post fra Skattestyrelsen i din digitale postkasse.

Log på e-boks.dk eller app'en for at læse den.

Venlig hilsen
e-Boks`;

const MITDK_EMAIL = { from: "mit.dk <noreply@notifikation.mit.dk>", subject: "Ny post fra Aarhus Kommune", date: "2026-11-01T18:00:00Z" };
const MITDK_TEXT = "Hej\n\nDu har fået ny post i Digital Post.\nAfsender: Aarhus Kommune\nEmne: Indkaldelse til skoleindskrivning\n\nLog ind på mit.dk for at læse brevet.";

const NEWSLETTER = { from: "e-Boks <nyhedsbrev@e-boks.dk>", subject: "Nyheder fra e-Boks: ny app", date: null };

const TAX_LETTER = [
  { page: 1, text: `Skattestyrelsen
Nykøbing Bygade 30
4800 Nykøbing F

Anna Hansen
Testvej 1
8000 Aarhus C

Dato: 20. oktober 2026
Sagsnummer: 26-1234567

Partshøring om din forskudsopgørelse for 2027

Kære Anna Hansen

Vi har modtaget oplysninger, der kan ændre din forskudsopgørelse. Hvis du har bemærkninger, skal du sende dem til os senest den 24. november 2026.

Beløbet på 1.250 kr. skal være betalt senest 1. december 2026.

Med venlig hilsen
Skattestyrelsen` },
  { page: 2, text: "Klagevejledning\nDu kan klage inden 4 uger. Fristen for at klage er den 20.01.2027." },
];

const HOSPITAL_LETTER = [
  { page: 1, text: `Aarhus Universitetshospital
Øjenafdelingen

Kære Emil Hansen

Indkaldelse til undersøgelse

Du har tid den 3. december 2026 kl. 10.30 i Øjenambulatoriet, indgang C.
Mødetid: 03.12.2026 kl. 10.15

Med venlig hilsen
Øjenafdelingen` },
];

const NOT_A_LETTER = [{ page: 1, text: "Referat fra bestyrelsesmødet. Vi talte om Aarhus Kommune og om budgettet for næste år. Ingen frister." }];

const OLD_LETTER = [{ page: 1, text: "Udbetaling Danmark\n\nKære Anna\n\nDu skal svare senest den 3. marts 2024.\n\nMed venlig hilsen\nUdbetaling Danmark" }];

const MEDICINKORT = [
  { page: 1, text: `sundhed.dk
Medicinkortet
Udskrevet 01.11.2026
Præparat Styrke Dosering Behandling
Panodil 500 mg tabletter 1-2 tabletter op til 4 gange daglig Smerter
Ventoline 0,1 mg/dosis inhalation 2 pust ved behov Astma
Side 1 af 1` },
];

const VACCINATIONER = [
  { page: 1, text: `www.sundhed.dk
Vaccinationer
Dato Vaccine
12.03.2021 Comirnaty (Pfizer-BioNTech) dosis 1
02.04.2021 Comirnaty (Pfizer-BioNTech) dosis 2
15.10.2025 Influenzavaccine
Side 1` },
];

const LAB = [
  { page: 1, text: `sundhed.dk - Laboratoriesvar
Analyse Resultat Enhed Reference Dato
P-Hæmoglobin 8,9 mmol/l 8,3 - 10,5 01.10.2026
P-Kolesterol 5,8 mmol/l 01.10.2026
Hb(B)-Glykeret hæmoglobin 38 mmol/mol 01.10.2026` },
];

const JOURNAL = [
  { page: 1, text: `sundhed.dk
Min sundhedsjournal
Diagnoser
DJ45.9 Astma, uspecificeret
DM54.5 Lændesmerter
Kontakter
04.05.2025 Ambulant besøg, Lungemedicinsk Ambulatorium, Aarhus Universitetshospital` },
];

/* ── Dates and authorities ───────────────────────────────────────────────────────────────────────────── */

describe("Danish dates", () => {
  it("reads written, numeric and ISO dates, with times", () => {
    const d = findDates("senest den 24. november 2026, mødetid 03.12.2026 kl. 10.15 og 2027-01-20, ikke 31.02.2026");
    expect(d.map((x) => [x.year, x.month, x.day, x.hour ?? null])).toEqual([[2026, 11, 24, null], [2026, 12, 3, 10], [2027, 1, 20, null]]);
  });
  it("turns Copenhagen time into UTC across summer time", () => {
    expect(copenhagenToIso({ year: 2026, month: 12, day: 3, hour: 10, minute: 30 })).toBe("2026-12-03T09:30:00.000Z");
    expect(copenhagenToIso({ year: 2026, month: 7, day: 3, hour: 10, minute: 30 })).toBe("2026-07-03T08:30:00.000Z");
  });
});

describe("authorities", () => {
  it("names Danish public senders, including ones starting with Æ, Ø, Å", () => {
    const a = findAuthorities("Brev fra Skattestyrelsen og Ærø Kommune, kopi til Styrelsen for Patientsikkerhed og Region Midtjylland. Sundhedsstyrelsen.");
    expect(a.map((x) => x.name)).toEqual(["Skattestyrelsen", "Ærø Kommune", "Styrelsen for Patientsikkerhed", "Region Midtjylland", "Sundhedsstyrelsen"]);
  });
  it("drops a leading word that isn't part of the kommune's name", () => {
    expect(findAuthorities("Kontakt Aarhus Kommune")[0].name).toBe("Aarhus Kommune");
  });
  it("finds hospitals and schools (schools only when asked)", () => {
    expect(findAuthorities("Aarhus Universitetshospital, Øjenafdelingen")[0].name).toBe("Aarhus Universitetshospital");
    expect(findAuthorities("Lindevangskolen")).toEqual([]);
    expect(findAuthorities("Lindevangskolen", { schools: true })[0]).toMatchObject({ name: "Lindevangskolen", kind: "school" });
  });
});

/* ── Digital Post notices ────────────────────────────────────────────────────────────────────────────── */

describe("Digital Post notices", () => {
  it("recognises an e-Boks notice and its sender", () => {
    const n = classifyDigitalPostEmail(EBOKS_EMAIL, EBOKS_TEXT);
    expect(n).toMatchObject({ service: "e-Boks", sender: "Skattestyrelsen" });
    expect(n!.quote).toContain("post fra Skattestyrelsen");
  });
  it("recognises a mit.dk notice with Afsender and Emne lines", () => {
    expect(classifyDigitalPostEmail(MITDK_EMAIL, MITDK_TEXT)).toMatchObject({ service: "mit.dk", sender: "Aarhus Kommune", letterTitle: "Indkaldelse til skoleindskrivning" });
  });
  it("ignores other mail from the same services and ordinary mail", () => {
    expect(classifyDigitalPostEmail(NEWSLETTER, "Prøv vores nye app.")).toBeNull();
    expect(classifyDigitalPostEmail({ from: "mor@example.dk", subject: "Middag på søndag", date: null }, "Har du set brevet fra kommunen?")).toBeNull();
  });
  it("takes a forwarded notice only when the subject says new post and names the service", () => {
    expect(classifyDigitalPostEmail({ from: "anna@example.dk", subject: "Fwd: Du har modtaget ny post", date: null }, "Du har modtaget post fra Udbetaling Danmark i e-Boks.")).toMatchObject({ service: "e-Boks", sender: "Udbetaling Danmark" });
  });
  it("proposes one reminder with a receipt, in the reader's language", () => {
    const n = classifyDigitalPostEmail(EBOKS_EMAIL, EBOKS_TEXT)!;
    const [op] = digitalPostOps(n, { sourceId: "s1", sentAt: new Date(EBOKS_EMAIL.date), now: NOW, locale: "da" });
    expect(op).toMatchObject({ op: "addReminder", title: "Nyt brev fra Skattestyrelsen i Digital Post – åbn det i e-Boks", receipt: { sourceId: "s1" } });
    const [en] = digitalPostOps(n, { sourceId: "s1", sentAt: null, now: NOW, locale: "en" });
    expect(en).toMatchObject({ title: "New letter from Skattestyrelsen in Digital Post — open it in e-Boks", dueAt: NOW.toISOString() });
  });
});

/* ── Public letters ──────────────────────────────────────────────────────────────────────────────────── */

describe("public letters", () => {
  it("reads sender, type and deadlines of a tax letter", () => {
    const l = classifyPublicLetter(TAX_LETTER, NOW)!;
    expect(l.authority.name).toBe("Skattestyrelsen");
    expect(l.type).toBe("preliminary_tax");
    expect(l.deadlines.map((d) => [d.kind, d.date.month, d.date.day, d.page])).toEqual([
      ["reply", 11, 24, 1], ["payment", 12, 1, 1], ["complaint", 1, 20, 2],
    ]);
  });
  it("reads an appointment from a hospital summons", () => {
    const l = classifyPublicLetter(HOSPITAL_LETTER, NOW)!;
    expect(l.authority.name).toBe("Aarhus Universitetshospital");
    expect(l.type).toBe("summons");
    expect(l.deadlines.some((d) => d.kind === "appointment" && d.date.day === 3 && d.date.hour === 10)).toBe(true);
  });
  it("is not fooled by a document that only mentions a kommune", () => {
    expect(classifyPublicLetter(NOT_A_LETTER, NOW)).toBeNull();
  });
  it("leaves out deadlines long gone", () => {
    const l = classifyPublicLetter(OLD_LETTER, NOW)!;
    expect(l.authority.name).toBe("Udbetaling Danmark");
    expect(l.deadlines).toEqual([]);
    expect(l.stale).toBe(1);
  });
  it("proposes the sender as an organization, links the document and reminds before each deadline", () => {
    const l = classifyPublicLetter(TAX_LETTER, NOW)!;
    const ops = publicLetterOps(l, { sourceId: "s1", docNodeId: "doc1", known: [], visibility: "parents", now: NOW, mint, locale: "en" });
    const org = ops.find((c) => c.op === "addNode")!;
    expect(org).toMatchObject({ type: "organization", label: "Skattestyrelsen", visibility: "parents" });
    expect(ops.find((c) => c.op === "addEdge")).toMatchObject({ fromId: "doc1", relation: "mentions" });
    const reminders = ops.filter((c): c is Extract<ChangeInput, { op: "addReminder" }> => c.op === "addReminder");
    expect(reminders[0]).toMatchObject({ title: "Reply to Skattestyrelsen by 24 November 2026", dueAt: "2026-11-21T08:00:00.000Z", receipt: { locator: { page: 1 } } });
    expect(reminders[0].receipt!.quote).toContain("senest den 24. november 2026");
    expect(reminders[1].title).toBe("Pay Skattestyrelsen by 1 December 2026");
  });
  it("reuses a known organization", () => {
    const l = classifyPublicLetter(TAX_LETTER, NOW)!;
    const ops = publicLetterOps(l, { sourceId: "s1", docNodeId: null, known: [{ id: "org1", type: "organization", label: "Skattestyrelsen", aliases: [] }], visibility: "private", now: NOW, mint, locale: "da" });
    expect(ops.some((c) => c.op === "addNode")).toBe(false);
    expect(ops.find((c) => c.op === "addReminder")).toMatchObject({ aboutNodeId: "org1", title: "Svar Skattestyrelsen senest 24. november 2026" });
  });
});

/* ── sundhed.dk ──────────────────────────────────────────────────────────────────────────────────────── */

describe("sundhed.dk printouts", () => {
  it("is recognised only when sundhed.dk is named", () => {
    expect(sundhedSections(MEDICINKORT[0].text)).toEqual(["medication"]);
    expect(sundhedSections("Medicinkortet fra lægen")).toEqual([]);
  });
  it("reads medicines", () => {
    const d = readSundhed(MEDICINKORT, ["medication"]);
    expect(d.records.map((r) => [r.type, r.name])).toEqual([["medication", "Panodil"], ["medication", "Ventoline"]]);
    expect(d.records[0].note).toContain("500 mg");
  });
  it("reads vaccinations with their dates", () => {
    const d = readSundhed(VACCINATIONER, ["vaccination"]);
    expect(d.records.map((r) => [r.type, r.at?.slice(0, 10)])).toEqual([["vaccination", "2021-03-12"], ["vaccination", "2021-04-02"], ["vaccination", "2025-10-15"]]);
    expect(d.records[0].name).toContain("Comirnaty");
  });
  it("reads lab results with value, unit and reference", () => {
    const d = readSundhed(LAB, sundhedSections(LAB[0].text));
    expect(d.records[0]).toMatchObject({ type: "lab", name: "P-Hæmoglobin", value: 8.9, unit: "mmol/l", note: "Reference 8,3-10,5" });
    expect(d.records).toHaveLength(3);
  });
  it("reads diagnoses and visits from the journal", () => {
    const d = readSundhed(JOURNAL, sundhedSections(JOURNAL[0].text));
    expect(d.records.filter((r) => r.type === "condition").map((r) => r.name)).toEqual(["Astma, uspecificeret", "Lændesmerter"]);
    expect(d.records.find((r) => r.type === "visit")?.at?.slice(0, 10)).toBe("2025-05-04");
  });
});

/* ── The pipeline hook ───────────────────────────────────────────────────────────────────────────────── */

describe("the pipeline hook", () => {
  const ctx = { sourceId: "s1", docNodeId: "doc1", known: [], existingEdges: new Set<string>(), visibility: "household" as const, selfNodeId: "me", now: NOW, mint, locale: "en" as const };

  it("marks a sundhed.dk printout sensitive and proposes private entries linked to the person", () => {
    const r = readDanishDocument({ fileKind: "pdf", title: "vaccinationer.pdf", segments: VACCINATIONER, now: NOW })!;
    expect(r).toMatchObject({ kind: "sundhed", sensitive: true });
    const ops = withDanishOps(r, [], ctx);
    const nodes = ops.filter((c) => c.op === "addNode");
    expect(nodes.length).toBe(3);
    expect(nodes.every((c) => c.op === "addNode" && c.visibility === "private")).toBe(true);
    expect(ops.filter((c) => c.op === "addEdge" && c.toId === "me")).toHaveLength(3);
    expect(nodes[0].receipt).toMatchObject({ locator: { page: 1 } });
    // The person's own fields aren't known here, so their allergies are never written.
    expect(ops.some((c) => c.op === "updateNode")).toBe(false);
  });

  it("reads an email notice, not a letter, from an email", () => {
    const r = readDanishDocument({ fileKind: "email", title: "x", segments: [{ text: EBOKS_TEXT }], email: EBOKS_EMAIL, now: NOW })!;
    expect(r.kind).toBe("digital_post");
    expect(withDanishOps(r, [], ctx)).toHaveLength(1);
  });

  it("replaces the model's reminder for the same deadline and reuses its organization", () => {
    const r = readDanishDocument({ fileKind: "pdf", title: "brev.pdf", segments: TAX_LETTER, now: NOW })!;
    const model: ChangeInput[] = [
      { op: "addNode", nodeId: "m-org", type: "organization", label: "Skattestyrelsen" },
      { op: "addReminder", title: "Svar til SKAT", dueAt: "2026-11-24T09:00:00.000Z" },
      { op: "addReminder", title: "Something else", dueAt: "2026-11-10T09:00:00.000Z" },
    ];
    const out = withDanishOps(r, model, ctx);
    expect(out.filter((c) => c.op === "addNode")).toHaveLength(1);
    expect(out.some((c) => c.op === "addReminder" && c.title === "Svar til SKAT")).toBe(false);
    expect(out.some((c) => c.op === "addReminder" && c.title === "Something else")).toBe(true);
    expect(out.find((c) => c.op === "addEdge")).toMatchObject({ toId: "m-org" });
  });

  it("leaves ordinary documents alone", () => {
    expect(readDanishDocument({ fileKind: "pdf", title: "referat.pdf", segments: NOT_A_LETTER, now: NOW })).toBeNull();
    expect(readDanishDocument({ fileKind: "audio", title: "a.m4a", segments: TAX_LETTER, now: NOW })).toBeNull();
  });
});
