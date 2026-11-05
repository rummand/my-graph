import { describe, expect, it } from "vitest";
import type { ChangeInput } from "@/lib/changes";
import { amountsIn, parseNumber } from "./amount";
import type { Candidate, DetectInput, Segment, SourceKind } from "./candidate";
import { noticeDeadline, noticePeriodIn } from "./contracts";
import { detectCommitments } from "./detect";
import { commitmentFingerprint, normParty } from "./fingerprint";
import { commitmentLabel } from "./labels";
import { buildMessages, cuePassages, findVerbatim, parseModelAnswer } from "./model";
import { commitmentOps, withCommitments, type OpsContext } from "./ops";
import { emailInfoOf, sourceKindOf } from "./server";
import { timeLimitOf } from "./rules";
import { allWhens, dayKey, whenIn } from "./when";

// Thursday 5 November 2026, 11:00 in Copenhagen.
const NOW = new Date("2026-11-05T10:00:00Z");

function input(text: string | Segment[], o: Partial<DetectInput> & { kind?: SourceKind } = {}): DetectInput {
  const segments = typeof text === "string" ? [{ text }] : text;
  return { title: o.title ?? "Test", segments, sourceKind: o.kind ?? "document", docDate: o.docDate ?? null, now: o.now ?? NOW, locale: o.locale ?? "da", email: o.email ?? null, self: o.self ?? { names: ["Anna Jensen"], emails: ["anna@example.com"] } };
}
const detect = (text: string | Segment[], o: Parameters<typeof input>[1] = {}) => detectCommitments(input(text, o)).candidates;

const LETTER = `Vejle Kommune
Skoleafdelingen
Skolegade 1, 7100 Vejle

Dato: 2. november 2026
Sagsnr.: 2026-1234

Kære Anna Jensen

Partshøring om skolebuskort til Emma

Vi har modtaget din ansøgning om skolebuskort. Før vi træffer afgørelse, vil vi gerne høre dine bemærkninger.
Svarfrist: 20. november 2026.
Hvis du ikke svarer, træffer vi afgørelse på det foreliggende grundlag.

Med venlig hilsen
Vejle Kommune`;

describe("Danish letter deadlines", () => {
  it("turns a svarfrist into a reply to the sender, with the subject and what happens if missed", () => {
    const [c] = detect(LETTER, { docDate: new Date("2026-11-02T09:00:00Z") });
    expect(c).toMatchObject({ detector: "letter", kind: "reply", flavor: "hearing", direction: "owe", dueDay: "2026-11-20", dueKind: "deadline" });
    expect(c.counterparty?.name).toBe("Vejle Kommune");
    expect(c.subject).toBe("skolebuskort til Emma");
    expect(c.consequence).toMatch(/^Hvis du ikke svarer/);
    expect(LETTER).toContain(c.quote.split(" ").slice(0, 2).join(" "));
    expect(commitmentLabel(c, "da")).toBe("Svar Vejle Kommune på partshøringen om skolebuskort til Emma");
    expect(commitmentLabel(c, "en")).toBe("Answer Vejle Kommune's consultation about skolebuskort til Emma");
  });

  it("reads 'senest den …' and 'inden 14 dage fra modtagelsen' (counted from the letter's date)", () => {
    const text = `Aarhus Kommune\nBorgerservice\nSagsnummer: 99-1\n\nKære Peter\n\nDu skal sende os lønsedler for de seneste tre måneder. Du skal svare inden 14 dage fra modtagelsen af dette brev.\nVi skal have dokumentationen senest den 1. december 2026.\n\nMed venlig hilsen\nAarhus Kommune`;
    const cs = detect(text, { docDate: new Date("2026-11-03T08:00:00Z") });
    const days = cs.map((c) => `${c.kind}:${c.dueDay}`).sort();
    expect(days).toContain("reply:2026-11-17");
    expect(cs.find((c) => c.dueDay === "2026-11-17")?.dueWords).toMatch(/inden 14 dage fra modtagelsen/);
    expect(cs.some((c) => c.dueDay === "2026-12-01")).toBe(true);
  });

  it("makes a klagefrist the last day to appeal (notice)", () => {
    const text = `Udbetaling Danmark\nJournalnummer 12\n\nAfgørelse om boligstøtte\n\nDu kan klage over afgørelsen. Klagefrist: 30. november 2026.\n\nMed venlig hilsen\nUdbetaling Danmark`;
    const [c] = detect(text);
    expect(c).toMatchObject({ kind: "notice", flavor: "complaint", dueDay: "2026-11-30" });
    expect(commitmentLabel(c, "en")).toBe("Last day to appeal Udbetaling Danmark's decision about boligstøtte");
  });
});

describe("invoices", () => {
  it("finds the total, the due date and the payee of a Danish bill (betalingsfrist)", () => {
    const text = `Norlys A/S\nFaktura\nFakturanr.: 884421\nFakturadato: 01.11.2026\n\nForbrug el oktober\nBeløb ekskl. moms 1.000,00 kr\nMoms 250,00 kr\nI alt at betale: 1.250,00 kr.\nBetalingsfrist: 20.11.2026`;
    const [c] = detect(text);
    expect(c).toMatchObject({ detector: "invoice", kind: "payment", direction: "owe", dueDay: "2026-11-20", amount: { value: 1250, currency: "DKK" } });
    expect(c.counterparty?.name).toBe("Norlys A/S");
    expect(c.quote).toBe("Betalingsfrist: 20.11.2026");
    expect(commitmentLabel(c, "da")).toBe("Betal 1.250 kr. til Norlys A/S for faktura 884421");
  });

  it("reads forfaldsdato, an English invoice, and leaves receipts alone", () => {
    const a = detect(`Regning fra VVS-Hansen ApS\nBeløb: 3.400 kr.\nForfaldsdato: 15. december 2026`)[0];
    expect(a).toMatchObject({ kind: "payment", dueDay: "2026-12-15", amount: { value: 3400, currency: "DKK" } });
    const b = detect(`ACME Ltd\nInvoice #A-1001\nAmount due: $45.00\nDue date: December 1, 2026`, { locale: "en" })[0];
    expect(b).toMatchObject({ kind: "payment", dueDay: "2026-12-01", amount: { value: 45, currency: "USD" } });
    expect(commitmentLabel(b, "en")).toBe("Pay ACME Ltd $45 for invoice A-1001");
    expect(detect(`Kvittering for betaling\nFaktura 12\nBetalingen er modtaget. Betalingsfrist: 20.11.2026`)).toHaveLength(0);
  });

  it("parses Danish and English amounts", () => {
    expect(parseNumber("1.234,50")).toBe(1234.5);
    expect(parseNumber("1,234.50")).toBe(1234.5);
    expect(parseNumber("4.200")).toBe(4200);
    expect(parseNumber("120.00")).toBe(120);
    expect(amountsIn("Pris 4.200,- og DKK 99,95 og € 12.50").map((a) => [a.value, a.currency])).toEqual([[4200, "DKK"], [99.95, "DKK"], [12.5, "EUR"]]);
  });
});

describe("insurance and leases: renewal and notice math", () => {
  const POLICY = `Tryg Forsikring A/S\nPoliceoversigt – Bilforsikring\nPolicenummer: 123456\nHovedforfald: 1. januar\nÅrlig præmie: 4.200 kr.\nForsikringen fornyes automatisk for et år ad gangen. Forsikringen kan opsiges med 1 måneds varsel til hovedforfald.`;

  it("finds the yearly main due date and the last day to cancel (renewal − notice period)", () => {
    const cs = detect(POLICY);
    const renewal = cs.find((c) => c.kind === "renewal")!;
    const notice = cs.find((c) => c.kind === "notice")!;
    expect(renewal).toMatchObject({ dueDay: "2027-01-01", recurrence: "FREQ=YEARLY", dueKind: "recurring", amount: { value: 4200, currency: "DKK" } });
    expect(renewal.counterparty?.name).toBe("Tryg Forsikring A/S");
    expect(notice).toMatchObject({ dueDay: "2026-12-01", recurrence: "FREQ=YEARLY", flavor: "cancel" });
    expect(notice.consequence).toBe("Bilforsikring fornyes for et år til 4.200 kr.");
    expect(commitmentLabel(notice, "da")).toBe("Sidste frist for at opsige bilforsikring hos Tryg Forsikring A/S");
    expect(commitmentLabel(renewal, "en")).toBe("Bilforsikring with Tryg Forsikring A/S renews");
  });

  it("does the notice math for plain periods and 'løbende måned'", () => {
    const jan1 = { year: 2027, month: 1, day: 1 };
    expect(dayKey(noticeDeadline(jan1, { n: 3, unit: "month", runningMonth: false }))).toBe("2026-10-01");
    expect(dayKey(noticeDeadline(jan1, { n: 1, unit: "month", runningMonth: true }))).toBe("2026-11-30");
    expect(dayKey(noticeDeadline(jan1, { n: 3, unit: "month", runningMonth: true }))).toBe("2026-09-30");
    expect(dayKey(noticeDeadline({ year: 2027, month: 3, day: 31 }, { n: 1, unit: "month", runningMonth: false }))).toBe("2027-02-28");
    expect(noticePeriodIn("Opsigelsesvarsel: løbende måned + 1 måned")).toMatchObject({ n: 1, unit: "month", runningMonth: true });
    expect(noticePeriodIn("Lejer kan opsige lejemålet med 3 måneders varsel")).toMatchObject({ n: 3, unit: "month", runningMonth: false });
    expect(noticePeriodIn("with a notice period of 30 days")).toMatchObject({ n: 30, unit: "day" });
  });

  it("reads an English lease's expiry", () => {
    const cs = detect(`Tenancy agreement\nLandlord: Riverside Homes\nThe lease expires on 31 March 2027.\nEither party may terminate with 2 months' notice.`, { locale: "en" });
    expect(cs.find((c) => c.kind === "renewal")).toMatchObject({ dueDay: "2027-03-31", recurrence: null });
    expect(cs.find((c) => c.kind === "notice")).toMatchObject({ dueDay: "2027-01-31" });
    expect(cs[0].counterparty?.name).toBe("Riverside Homes");
  });
});

describe("school messages", () => {
  const AULA = `Kære forældre i 2.B\nPå fredag skal vi i skoven. Husk madpakke og regntøj.\nMedbring gummistøvler på fredag.\nTilmelding til julefrokosten senest 12. november 2026.\nForældremøde torsdag den 19. november 2026 kl. 19.00 i klassen.`;

  it("finds bring / sign up / meeting with their days, and skips 'husk' without a day", () => {
    const cs = detect(AULA, { kind: "message", docDate: new Date("2026-11-04T08:00:00Z") });
    const by = (k: string) => cs.filter((c) => c.kind === k);
    expect(by("deliver")).toHaveLength(1);
    expect(by("deliver")[0]).toMatchObject({ dueDay: "2026-11-06", action: "Medbring gummistøvler", owner: { by: "about" } });
    expect(by("form")[0]).toMatchObject({ dueDay: "2026-11-12" });
    expect(by("appointment")[0]).toMatchObject({ dueDay: "2026-11-19" });
    expect(by("appointment")[0].dueAt).toBe("2026-11-19T18:00:00.000Z");
    const consent = detect("Kære forældre\nGiv samtykke i Aula senest mandag den 9. november, så Noah kan komme med til svømning.", { kind: "message" });
    expect(consent[0]).toMatchObject({ kind: "form", dueDay: "2026-11-09", action: "Giv samtykke i Aula" });
  });
});

describe("emails and chats: requests and promises", () => {
  const email = (from: string, body: string, subject = "Hej") => input(`Subject: ${subject}\nFrom: ${from}\nTo: anna@example.com\n\n${body}`, {
    kind: "email", docDate: new Date("2026-11-04T09:00:00Z"),
    email: { from: { name: from.split(" <")[0], email: /<(.+)>/.exec(from)![1] }, to: [{ name: "Anna", email: "anna@example.com" }], subject },
  });

  it("a Danish request with 'inden fredag' is the reader's to do, for the sender", () => {
    const [c] = detectCommitments(email("Lars Holm <lars@example.com>", "Hej Anna\n\nKan du sende den underskrevne kontrakt inden fredag?\n\nHilsen Lars")).candidates;
    expect(c).toMatchObject({ kind: "deliver", direction: "owe", owner: { by: "viewer" }, dueDay: "2026-11-06", dueKind: "deadline" });
    expect(c.counterparty).toMatchObject({ name: "Lars Holm", email: "lars@example.com" });
    expect(c.action).toBe("sende den underskrevne kontrakt");
  });

  it("an English request to pay back, and quoted replies are ignored", () => {
    const body = "Hi Anna,\nCould you pay me back the 200 kr for the tickets by Friday?\nThanks\n\nOn Mon, 2 Nov 2026 Anna wrote:\n> Can you send me the photos by Monday?";
    const cs = detectCommitments(email("Lars Holm <lars@example.com>", body)).candidates;
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ kind: "payment", direction: "owe", dueDay: "2026-11-06" });
  });

  it("a newsletter's 'remember to' is not a request", () => {
    expect(detectCommitments(email("Shop <newsletter@shop.dk>", "Husk at bestille inden fredag!")).candidates).toHaveLength(0);
  });

  const CHAT = [{ text: "WhatsApp · Lars · 2026-11-03\n18:02 Lars: I'll return the trailer next week\n18:05 Anna Jensen: Super, tak! Jeg betaler dig tilbage i morgen\n18:07 Lars: Husk at betale for hytten inden søndag", region: "Lars · 2026-11-03" }];

  it("a promise by the other person is theirs, with an approximate date and its wording", () => {
    const cs = detect(CHAT, { kind: "chat" });
    const trailer = cs.find((c) => /trailer/.test(c.quote))!;
    expect(trailer).toMatchObject({ kind: "return", direction: "promise", owner: { by: "person", name: "Lars" }, dueKind: "approx", dueDay: "2026-11-13", dueWords: "next week" });
    expect(commitmentLabel(trailer, "en", { owner: "Lars" })).toBe("Lars promised: return the trailer");
  });

  it("the reader's own promise and a request to them", () => {
    const cs = detect(CHAT, { kind: "chat" });
    expect(cs.find((c) => /betaler dig tilbage/.test(c.quote))).toMatchObject({ kind: "payment", direction: "promise", owner: { by: "viewer" }, dueDay: "2026-11-04", counterparty: { name: "Lars" }, action: "betaler dig tilbage" });
    expect(cs.find((c) => /hytten/.test(c.quote))).toMatchObject({ kind: "payment", direction: "owe", owner: { by: "viewer" }, dueDay: "2026-11-08", counterparty: { name: "Lars" } });
  });

  it("old chat history holds no open promises", () => {
    expect(detect([{ text: "WhatsApp · Lars · 2025-03-01\n18:02 Lars: I'll return the trailer next week" }], { kind: "chat" })).toHaveLength(0);
  });

  it("an invitation that asks for an answer", () => {
    const i = input(`Subject: Invitation: Sankt Hans i haven\nFrom: Mette <mette@example.com>\n\nHvornår: lørdag 21. november 2026 kl. 15.00\nSvar venligst senest 15. november 2026\nJa · Måske · Nej`, {
      kind: "email", email: { from: { name: "Mette", email: "mette@example.com" }, to: [{ name: "Anna", email: "anna@example.com" }], subject: "Invitation: Sankt Hans i haven" },
    });
    const [c] = detectCommitments(i).candidates;
    expect(c).toMatchObject({ kind: "reply", flavor: "invitation", dueDay: "2026-11-15", subject: "Sankt Hans i haven" });
  });
});

describe("precision: ordinary text has no commitments", () => {
  it("a meeting summary, a recipe and an old letter's stale deadline propose nothing", () => {
    expect(detect("Referat fra generalforsamlingen\nVi talte om haven og budgettet. Næste år vil vi plante flere æbletræer.")).toHaveLength(0);
    expect(detect("Æblekage\nBland mel og smør. Bag i 25 minutter ved 200 grader. Server med flødeskum.")).toHaveLength(0);
    expect(detect(LETTER.replace("20. november 2026", "20. januar 2026"))).toHaveLength(0);
  });
});

describe("vague and relative dates", () => {
  const thu = { year: 2026, month: 11, day: 5 };
  const day = (t: string) => { const w = whenIn(t, thu); return w ? `${dayKey(w.day)}:${w.dueKind}` : null; };
  it("resolves weekdays, near days and spans to a best date", () => {
    expect(day("i næste uge")).toBe("2026-11-13:approx");
    expect(day("next week")).toBe("2026-11-13:approx");
    expect(day("inden fredag")).toBe("2026-11-06:deadline");
    expect(day("next Tuesday")).toBe("2026-11-10:date");
    expect(day("på torsdag")).toBe("2026-11-12:date");
    expect(day("i morgen")).toBe("2026-11-06:date");
    expect(day("sidst på måneden")).toBe("2026-11-30:approx");
    expect(day("i weekenden")).toBe("2026-11-07:approx");
    expect(day("ultimo december")).toBe("2026-12-31:approx");
    expect(day("om to uger")).toBe("2026-11-19:approx");
    expect(day("within 10 business days")).toBe("2026-11-19:deadline");
    expect(day("fredag var vi i skoven")).toBeNull();
  });
  it("absolute dates win and a year-less date is the next one", () => {
    expect(allWhens("senest den 3. december", thu)[0].day).toMatchObject({ year: 2026, month: 12, day: 3 });
    expect(allWhens("senest den 3. marts", thu)[0].day).toMatchObject({ year: 2027, month: 3, day: 3 });
    expect(allWhens("kl. 9.05.", thu)).toHaveLength(0);
    expect(allWhens("on Friday 12 April 2027 we go", thu)).toHaveLength(1);
    expect(whenIn("torsdag den 12. november kl. 17.00", thu)).toMatchObject({ day: { year: 2026, month: 11, day: 12, hour: 17, minute: 0 }, dueKind: "date" });
  });
});

describe("rules with time limits", () => {
  it("reads the period and trigger of an appeal rule", () => {
    expect(timeLimitOf({ title: "Klagefrist", text: "Klagefristen er 4 uger fra den dag, du har modtaget afgørelsen.", quote: null })).toMatchObject({ n: 4, unit: "week", trigger: "decision" });
    expect(timeLimitOf({ title: "Husorden", text: "Affald skal i containeren.", quote: null })).toBeNull();
  });

  it("a decision letter without its own klagefrist gets one from the rule, with both receipts", () => {
    const text = `Familieretshuset\nSagsnr. 7\n\nAfgørelse om samvær\n\nVi har truffet afgørelse om samvær for Emma.\n\nMed venlig hilsen\nFamilieretshuset`;
    const rule = { id: "r1", nodeId: "rule-node", corpusName: "Forældreansvarsloven", ref: "§ 39", title: "Klage", text: "Klagefristen er 4 uger fra den dag, du har modtaget afgørelsen.", quote: "Fristen for at klage er 4 uger fra modtagelsen af afgørelsen.", sourceId: "law-src" };
    const [c] = detectCommitments(input(text, { docDate: new Date("2026-11-02T08:00:00Z") }), { rules: [rule] }).candidates;
    expect(c).toMatchObject({ detector: "rule", kind: "notice", flavor: "complaint", dueDay: "2026-11-30" });
    expect(c.quote).toMatch(/fgørelse/);
    const ops = commitmentOps([c], [], ctx({ text })).changes;
    const ruleEdge = ops.find((o) => o.op === "addEdge" && o.toId === "rule-node");
    expect(ruleEdge?.receipt).toMatchObject({ sourceId: "law-src", quote: rule.quote });
    expect(ops.find((o) => o.op === "addNode" && o.type === "commitment")?.receipt).toMatchObject({ sourceId: "src", quote: c.quote });
  });
});

/* ── Ops: owners, parties, de-duplication ─────────────────────────────────────────────────────────────── */

let n = 0;
function ctx(o: Partial<OpsContext> = {}): OpsContext {
  n = 0;
  return {
    sourceId: "src", sourceTitle: "Brev", docNodeId: "doc", visibility: "household", locale: "da", mint: () => `id${++n}`,
    known: [
      { id: "anna", type: "person", label: "Anna Jensen", aliases: [], emails: ["anna@example.com"] },
      { id: "peter", type: "person", label: "Peter Jensen", aliases: [] },
      { id: "emma", type: "person", label: "Emma Jensen", aliases: [] },
      { id: "lars", type: "person", label: "Lars Holm", aliases: [], emails: ["lars@example.com"] },
      { id: "vejle", type: "organization", label: "Vejle Kommune", aliases: [] },
    ],
    selfNodeId: "anna", children: [{ id: "emma", label: "Emma Jensen", aliases: [] }], parentsOf: new Map([["emma", ["peter", "anna"]]]),
    existing: [], dropped: { fingerprints: new Set(), quotes: new Set() }, text: "", ...o,
  };
}
const nodesOf = (ops: ChangeInput[]) => ops.filter((o) => o.op === "addNode" && o.type === "commitment");
const edgesOf = (ops: ChangeInput[], relation: string) => ops.filter((o): o is Extract<ChangeInput, { op: "addEdge" }> => o.op === "addEdge" && o.relation === relation);

describe("proposals from candidates", () => {
  const letter = () => detect(LETTER, { docDate: new Date("2026-11-02T09:00:00Z") })[0];

  it("proposes the commitment with owner, party, child and source — all with the letter's receipt", () => {
    const r = commitmentOps([letter()], [], ctx({ text: LETTER, chunks: [{ id: "ch1", text: LETTER, locator: { page: 1 } }] }));
    const [node] = nodesOf(r.changes);
    expect(node).toMatchObject({ kind: "reply", label: "Svar Vejle Kommune på partshøringen om skolebuskort til Emma", startAt: "2026-11-20T11:00:00.000Z" });
    expect((node as { props: Record<string, unknown> }).props).toMatchObject({ direction: "owe", status: "open", kind: "reply", dueKind: "deadline", leadDays: 5, fingerprint: "reply|vejle kommune|emma jensen|2026-11-20" });
    expect(edgesOf(r.changes, "responsible_for")[0]).toMatchObject({ fromId: "anna" });
    expect(edgesOf(r.changes, "with")[0]).toMatchObject({ toId: "vejle" });
    expect(edgesOf(r.changes, "about")[0]).toMatchObject({ toId: "emma" });
    expect(edgesOf(r.changes, "arises_from")[0]).toMatchObject({ toId: "doc" });
    for (const op of r.changes) expect(op.receipt).toMatchObject({ sourceId: "src", chunkId: "ch1", locator: { page: 1 } });
  });

  it("replaces the plain reminder for the same deadline", () => {
    const c = letter();
    const reminder: ChangeInput = { op: "addReminder", title: "Svar Vejle Kommune senest 20. november 2026", dueAt: "2026-11-17T08:00:00Z", detail: c.quote, receipt: { sourceId: "src", quote: c.quote } };
    const other: ChangeInput = { op: "addReminder", title: "Emma: tandlæge", dueAt: "2026-11-10T08:00:00Z", detail: "Coming up" };
    const out = withCommitments([reminder, other], commitmentOps([c], [reminder, other], ctx({ text: LETTER })));
    expect(out.filter((o) => o.op === "addReminder")).toEqual([other]);
    expect(nodesOf(out)).toHaveLength(1);
  });

  it("does not propose what exists, what waits, or what a person dropped", () => {
    const c = letter();
    const fp = commitmentFingerprint({ kind: "reply", counterparty: "Vejle Kommune", about: "Emma Jensen", dueDay: "2026-11-20" });
    const existing = { nodeId: "c1", fingerprint: fp, status: "open", kind: "reply", dueDay: "2026-11-20", label: "x", props: {}, receipts: [] };
    expect(commitmentOps([c], [], ctx({ text: LETTER, existing: [existing] })).counts).toMatchObject({ commitments: 0, duplicates: 1 });
    const sameQuote = { ...existing, fingerprint: "other", receipts: [{ sourceId: "src", quote: c.quote }] };
    expect(commitmentOps([c], [], ctx({ text: LETTER, existing: [sameQuote] })).counts.duplicates).toBe(1);
    expect(commitmentOps([c], [], ctx({ text: LETTER, dropped: { fingerprints: new Set([fp]), quotes: new Set() } })).counts).toMatchObject({ commitments: 0, dropped: 1 });
    const notMine = { ...existing, fingerprint: fp.replace("2026-11-20", "2026-10-01"), status: "cancelled", props: { cancelReason: "not_mine" } };
    expect(commitmentOps([c], [], ctx({ text: LETTER, existing: [notMine] })).counts.dropped).toBe(1);
  });

  it("a letter that moves a known deadline updates it instead", () => {
    const text = LETTER.replace("Svarfrist: 20. november 2026.", "Fristen er forlænget. Ny svarfrist: 27. november 2026.");
    const c = detect(text, { docDate: new Date("2026-11-04T09:00:00Z") })[0];
    const old = { nodeId: "c1", fingerprint: "reply|vejle kommune|emma jensen|2026-11-20", status: "open", kind: "reply", dueDay: "2026-11-20", label: "x", props: { direction: "owe", status: "open" }, receipts: [] };
    const r = commitmentOps([c], [], ctx({ text, existing: [old] }));
    expect(r.counts.updates).toBe(1);
    const u = r.changes.find((o) => o.op === "updateNode") as Extract<ChangeInput, { op: "updateNode" }>;
    expect(u.nodeId).toBe("c1");
    expect(u.set.props).toMatchObject({ direction: "owe", dueAt: c.dueAt, fingerprint: "reply|vejle kommune|emma jensen|2026-11-27" });
    expect(u.receipt?.quote).toBe(c.quote);
  });

  it("owner choice: a parent of the child (the reader if they are one), a promiser by name, a new party once", () => {
    const school: Candidate = { detector: "school", kind: "deliver", direction: "owe", dueAt: "2026-11-06T11:00:00.000Z", dueDay: "2026-11-06", dueKind: "date", counterparty: null, action: "Medbring gummistøvler", owner: { by: "about" }, quote: "Emma skal medbringe gummistøvler på fredag.", confidence: 0.7 };
    expect(edgesOf(commitmentOps([school], [], ctx()).changes, "responsible_for")[0].fromId).toBe("anna");
    expect(edgesOf(commitmentOps([school], [], ctx({ selfNodeId: "lars" })).changes, "responsible_for")[0].fromId).toBe("peter");
    const promise: Candidate = { detector: "message", kind: "return", direction: "promise", dueAt: null, dueDay: "2026-11-13", dueKind: "approx", counterparty: null, action: "return the trailer", owner: { by: "person", name: "Lars" }, quote: "I'll return the trailer next week", confidence: 0.6 };
    const p = commitmentOps([promise], [], ctx()).changes;
    expect(edgesOf(p, "responsible_for")[0].fromId).toBe("lars");
    expect(edgesOf(p, "with")[0].toId).toBe("anna");
    expect(nodesOf(p)[0]).toMatchObject({ label: "Lars Holm har lovet: return the trailer" });
    const bill: Candidate = { detector: "invoice", kind: "payment", direction: "owe", dueAt: "2026-11-20T11:00:00.000Z", dueDay: "2026-11-20", dueKind: "deadline", counterparty: { name: "Norlys A/S", type: "organization" }, owner: { by: "viewer" }, quote: "Betalingsfrist: 20.11.2026", confidence: 0.85 };
    const twice = commitmentOps([bill, { ...bill, quote: "Betales senest 20.11.2026" }], [], ctx()).changes;
    expect(twice.filter((o) => o.op === "addNode" && o.type === "organization")).toHaveLength(1);
    expect(nodesOf(twice)).toHaveLength(1);
  });

  it("reuses the reading's organisation by its leading words and drops an event that only restates the date", () => {
    const org: ChangeInput = { op: "addNode", nodeId: "o1", type: "organization", label: "Tryg Forsikring A/S" };
    const ev: ChangeInput = { op: "addNode", nodeId: "e1", type: "event", label: "Policy renewal", startAt: "2027-02-01T00:00:00Z" };
    const evEdge: ChangeInput = { op: "addEdge", fromId: "doc", toId: "e1", relation: "mentions" };
    const c: Candidate = { detector: "contract", kind: "renewal", direction: "owe", dueAt: "2027-02-01T11:00:00.000Z", dueDay: "2027-02-01", dueKind: "recurring", recurrence: "FREQ=YEARLY", counterparty: { name: "Tryg", type: "organization" }, owner: { by: "viewer" }, quote: "Hovedforfald: 1. februar", confidence: 0.85 };
    const r = commitmentOps([c], [org, ev, evEdge], ctx());
    expect(edgesOf(r.changes, "with")[0].toId).toBe("o1");
    const out = withCommitments([org, ev, evEdge], r);
    expect(out.some((o) => o.op === "addNode" && o.nodeId === "e1")).toBe(false);
    expect(out.some((o) => o.op === "addEdge" && o.toId === "e1")).toBe(false);
    expect(out[0]).toBe(org);
  });

  it("words the reader's own promise as theirs", () => {
    const c: Candidate = { detector: "message", kind: "payment", direction: "promise", dueAt: null, dueDay: "2026-11-06", dueKind: "date", counterparty: { name: "Lars", type: "person" }, action: "betaler dig tilbage for benzinen", owner: { by: "viewer" }, quote: "Jeg betaler dig tilbage for benzinen i morgen", confidence: 0.65 };
    expect(commitmentLabel(c, "da")).toBe("Lovet Lars: betaler dig tilbage for benzinen");
    expect(commitmentLabel(c, "en", { counterparty: "Lars Holm" })).toBe("Promised Lars Holm: betaler dig tilbage for benzinen");
  });

  it("never matches a party outside the given (this graph's) nodes", () => {
    const c: Candidate = { detector: "invoice", kind: "payment", direction: "owe", dueAt: null, dueDay: "2026-11-20", dueKind: "deadline", counterparty: { name: "Other Graph Org", type: "organization" }, owner: { by: "viewer" }, quote: "Betalingsfrist: 20.11.2026", confidence: 0.8 };
    const ops = commitmentOps([c], [], ctx()).changes;
    expect(ops.find((o) => o.op === "addNode" && o.type === "organization")).toMatchObject({ label: "Other Graph Org" });
  });
});

describe("fingerprints", () => {
  it("normalise names and legal forms", () => {
    expect(normParty("NORLYS A/S")).toBe("norlys");
    expect(commitmentFingerprint({ kind: "payment", counterparty: "Norlys A/S", about: null, dueDay: "2026-11-20T11:00:00Z" })).toBe("payment|norlys||2026-11-20");
  });
});

describe("the model layer", () => {
  const text = "Hej Anna\nVi skal have svar på tilbuddet i løbet af næste uge.\nHilsen Malerfirma Hansen";
  const i = input(text, { kind: "email" });

  it("fences the text and asks for JSON", () => {
    const [sys, user] = buildMessages(i, cuePassages(text));
    expect(sys.content).toMatch(/DATA from outside/);
    expect(user.content).toMatch(/<untrusted-text>[\s\S]*tilbuddet[\s\S]*<\/untrusted-text>/);
  });

  it("keeps only answers whose quote is verbatim in the text", () => {
    const ok = { kind: "reply", direction: "owe", actor: "me", counterparty: "Malerfirma Hansen", due: "2026-11-13", dueKind: "approx", dueWords: "i løbet af næste uge", label_en: "Answer Malerfirma Hansen about the quote", label_da: "Svar Malerfirma Hansen om tilbuddet", quote: "Vi skal have svar på tilbuddet i løbet af næste uge.", confidence: 0.7 };
    const made = { ...ok, quote: "Svar senest i morgen, ellers bortfalder tilbuddet." };
    const bad = { ...ok, kind: "wish" };
    const out = parseModelAnswer({ commitments: [ok, made, bad] }, { text, sourceText: text, input: i });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ detector: "model", kind: "reply", dueDay: "2026-11-13", dueKind: "approx", owner: { by: "viewer" } });
    expect(commitmentLabel(out[0], "da")).toBe("Svar Malerfirma Hansen om tilbuddet");
    expect(findVerbatim("Vi skal have  svar på", "x Vi skal have\nsvar på y")).toBe("Vi skal have\nsvar på");
  });
});

describe("server helpers (pure parts)", () => {
  it("knows what to look in", () => {
    expect(sourceKindOf({ kind: "upload", mime: "application/pdf", meta: {}, connectionId: null }, null)).toBe("document");
    expect(sourceKindOf({ kind: "connector", mime: "text/plain", meta: {}, connectionId: "c" }, "whatsapp")).toBe("chat");
    expect(sourceKindOf({ kind: "connector", mime: "text/vcard", meta: {}, connectionId: null }, "vcard")).toBeNull();
    expect(sourceKindOf({ kind: "upload", mime: "message/rfc822", meta: { email: {} }, connectionId: null }, null)).toBe("email");
    expect(emailInfoOf({ email: { from: "Lars <lars@x.dk>", to: "anna@x.dk", subject: "Hej" } })).toMatchObject({ from: { name: "Lars", email: "lars@x.dk" }, to: [{ email: "anna@x.dk" }] });
  });
});
