import { describe, expect, it } from "vitest";
import type { CommitmentProps } from "../types";
import { explainClash, findClashes, travelMinutes, type Slot } from "./clash";
import { classifySource, explainContradiction, findContradictions, strongerOf, type Claim, type Statement } from "./contradict";
import { donePhrase, matchFulfilment, matchHappenedEvent, type Evidence, type FulfilCommitment } from "./fulfil";
import { assessRisk, withSignal } from "./risk";
import { morningSummary } from "./summary";
import { findAmounts, findDueDates, findPeriods, nameVariants, parseNumber } from "./text";

const NOW = new Date("2026-11-05T07:00:00Z"); // Thursday morning in Copenhagen
const at = (s: string) => new Date(s);
const names: Record<string, string> = { emma: "Emma", anna: "Anna", lars: "Lars" };
const nameOf = (id: string) => names[id] ?? id;

function slot(p: Partial<Slot> & Pick<Slot, "id" | "label" | "start" | "people">): Slot {
  return { end: null, allDay: false, origin: "event", ...p };
}

describe("text", () => {
  it("reads Danish and English amounts", () => {
    expect(parseNumber("1.250,00")).toBe(1250);
    expect(parseNumber("1,250.00")).toBe(1250);
    expect(parseNumber("12,5")).toBe(12.5);
    expect(parseNumber("1.250,-")).toBe(1250);
    expect(findAmounts("Kvittering: 1.250,00 kr til Vejle Vand").map((a) => a.value)).toEqual([1250]);
    expect(findAmounts("Beløb: kr. 4.200 og DKK 1,250.50").map((a) => a.value)).toEqual([4200, 1250.5]);
    expect(findAmounts("Husleje 8.500,- pr. måned")[0]).toMatchObject({ value: 8500, currency: "DKK" });
    expect(findAmounts("Klasse 3 b, 12 elever")).toEqual([]);
  });

  it("knows a company by its name without the suffix", () => {
    expect(nameVariants("Vejle Vand A/S")).toEqual(["Vejle Vand A/S", "Vejle Vand"]);
    expect(nameVariants("Tryg")).toEqual(["Tryg"]);
  });

  it("reads periods with their topic", () => {
    expect(findPeriods("Lejemålet kan opsiges med 3 måneders varsel")[0]).toMatchObject({ days: 90, topic: "notice" });
    expect(findPeriods("You have 4 weeks to complain about the decision")[0]).toMatchObject({ days: 28, topic: "complaint" });
    expect(findPeriods("Klagefristen er to uger")[0]).toMatchObject({ days: 14, topic: "complaint" });
    expect(findPeriods("opsiges med 3 måneders varsel til den 1. i en måned").map((p) => p.days)).toEqual([90]);
  });

  it("reads due dates only after a deadline word", () => {
    const d = findDueDates("Beløbet skal være betalt senest 20. november. Brevet er sendt 1. november.", NOW);
    expect(d.map((x) => x.day)).toEqual(["2026-11-20"]);
    expect(findDueDates("Please reply by 3 December 2026", NOW)[0].day).toBe("2026-12-03");
    expect(findDueDates("Ny frist: senest 27.11.2026", NOW)[0]).toMatchObject({ day: "2026-11-27", moved: true });
  });
});

describe("clashes", () => {
  it("finds a school trip overlapping the dentist for the same child", () => {
    const trip = slot({ id: "trip", label: "School trip to Aarhus", start: at("2026-11-12T08:00:00Z"), end: at("2026-11-12T14:00:00Z"), people: ["emma"] });
    const dentist = slot({ id: "dent", label: "Dentist", start: at("2026-11-12T09:30:00Z"), people: ["emma", "anna"], origin: "commitment" });
    const out = findClashes([trip, dentist], { now: NOW });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "overlap", personIds: ["emma"] });
    expect(explainClash(out[0], nameOf, "en")).toBe("Emma: “School trip to Aarhus” (Thu 12 Nov 09:00–15:00) clashes with “Dentist” (10:30).");
    expect(explainClash(out[0], nameOf, "da")).toContain("falder sammen med „Dentist“ (10.30)");
  });

  it("counts an all-day trip but not an all-day birthday", () => {
    const trip = slot({ id: "trip", label: "Lejrskole", start: at("2026-11-11T23:00:00Z"), allDay: true, presence: true, people: ["emma"] });
    const bday = slot({ id: "bday", label: "Mormors fødselsdag", start: at("2026-11-11T23:00:00Z"), allDay: true, people: ["emma"] });
    const dentist = slot({ id: "dent", label: "Tandlæge", start: at("2026-11-12T09:30:00Z"), people: ["emma"] });
    const out = findClashes([trip, bday, dentist], { now: NOW });
    expect(out.map((c) => c.key)).toEqual(["overlap:dent|trip"]);
  });

  it("ignores the same thing twice, the past, and back-to-back without places", () => {
    const a = slot({ id: "a", label: "Dentist Emma", start: at("2026-11-12T09:30:00Z"), people: ["emma"] });
    const b = slot({ id: "b", label: "Emma dentist appointment", start: at("2026-11-12T09:30:00Z"), people: ["emma"], origin: "commitment" });
    const past = slot({ id: "p", label: "Swim", start: at("2026-11-01T09:30:00Z"), people: ["emma"] });
    const past2 = slot({ id: "p2", label: "Piano", start: at("2026-11-01T09:45:00Z"), people: ["emma"] });
    const next = slot({ id: "n", label: "Football", start: at("2026-11-12T10:30:00Z"), people: ["emma"] });
    expect(findClashes([a, b, past, past2, next], { now: NOW })).toEqual([]);
  });

  it("flags travel that is too tight when both places are known", () => {
    const vejle = { lat: 55.709, lon: 9.536 }, aarhus = { lat: 56.162, lon: 10.203 };
    expect(travelMinutes(vejle, aarhus)).toBeGreaterThan(90);
    const a = slot({ id: "a", label: "Work meeting", start: at("2026-11-12T08:00:00Z"), end: at("2026-11-12T09:00:00Z"), people: ["anna"], place: vejle });
    const b = slot({ id: "b", label: "Parent meeting", start: at("2026-11-12T09:45:00Z"), people: ["anna"], place: aarhus });
    const out = findClashes([a, b], { now: NOW });
    expect(out[0]).toMatchObject({ kind: "travel", gapMinutes: 45 });
    expect(explainClash(out[0], nameOf, "en")).toMatch(/^Anna has only 45 minutes from “Work meeting” \(ends 10:00\) to “Parent meeting” \(10:45\)/);
    // Close by: no clash.
    const c = { ...b, id: "c", place: { lat: 55.71, lon: 9.54 } };
    expect(findClashes([a, c], { now: NOW })).toEqual([]);
  });

  it("finds a child's appointment when both parents are booked", () => {
    const dentist = slot({ id: "dent", label: "Tandlæge", start: at("2026-11-12T09:30:00Z"), people: ["emma"], needsAdult: true });
    const annaWork = slot({ id: "aw", label: "Board meeting", start: at("2026-11-12T09:00:00Z"), end: at("2026-11-12T11:00:00Z"), people: ["anna"] });
    const larsFlight = slot({ id: "lf", label: "Flight to Oslo", start: at("2026-11-12T08:00:00Z"), end: at("2026-11-12T10:00:00Z"), people: ["lars"] });
    const caretakers = { emma: ["anna", "lars"] };
    const out = findClashes([dentist, annaWork, larsFlight], { now: NOW, caretakers });
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("nobody_free");
    expect(out[0].blockers?.map((b) => b.slot.id)).toEqual(["aw", "lf"]);
    expect(explainClash(out[0], nameOf, "en")).toContain("needs a grown-up, but Anna and Lars are both booked");
    // One parent free: nothing.
    expect(findClashes([dentist, annaWork], { now: NOW, caretakers })).toEqual([]);
  });
});

describe("contradictions", () => {
  const lease: Statement = { sourceId: "lease", title: "Lejekontrakt.pdf", cls: "official", date: at("2024-02-01T00:00:00Z"), text: "Lejer kan opsige lejemålet med 3 måneders varsel til den 1. i en måned." };
  const email: Statement = { sourceId: "mail", title: "Re: Opsigelse", cls: "email", date: at("2026-10-20T00:00:00Z"), text: "Hej Anna, du skal bare give 1 måneds varsel, så er det fint." };
  const notice = { id: "c1", kind: "notice" as const, dueAt: "2026-11-30T22:59:00Z" };

  it("orders sources: official > letter > email > chat, newer wins a tie", () => {
    const c = (cls: Claim["cls"], d: string): Claim => ({ sourceId: cls + d, title: cls, cls, date: at(d), quote: "", value: { field: "period", days: 30, topic: "notice" } });
    expect(strongerOf(c("official", "2020-01-01"), c("email", "2026-01-01"))?.cls).toBe("official");
    expect(strongerOf(c("email", "2026-01-01"), c("chat", "2026-02-01"))?.cls).toBe("email");
    expect(strongerOf(c("letter", "2026-01-01"), c("letter", "2026-02-01"))?.date?.toISOString()).toContain("2026-02-01");
    expect(strongerOf(c("rule", "2026-01-01"), c("letter", "2026-02-01"))).toBeNull();
  });

  it("classifies sources", () => {
    expect(classifySource({ kind: "email", meta: { email: {} } })).toBe("email");
    expect(classifySource({ kind: "upload", title: "Lejekontrakt.pdf", mime: "application/pdf" })).toBe("official");
    expect(classifySource({ kind: "upload", mime: "application/pdf", title: "brev.pdf" })).toBe("letter");
    expect(classifySource({ kind: "upload", meta: { importer: "whatsapp" } })).toBe("chat");
  });

  it("flags the lease's notice period against the landlord's email", () => {
    const out = findContradictions(notice, [lease, email]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ field: "period", winner: { sourceId: "lease" }, fix: null });
    expect(out[0].a.quote).toContain("3 måneders varsel");
    expect(out[0].b.quote).toContain("1 måneds varsel");
    expect(explainContradiction(out[0], "en")).toBe("“Lejekontrakt.pdf” says 3 months, “Re: Opsigelse” says 1 month. “Lejekontrakt.pdf” carries more weight.");
  });

  it("flags a rule against a letter, without proposing a fix", () => {
    const rule: Statement = { sourceId: "law", ruleId: "r1", ruleRef: "§ 16", title: "Forvaltningsloven", cls: "rule", date: null, text: "Klagefristen er 4 uger fra afgørelsen er modtaget." };
    const letter: Statement = { sourceId: "afg", title: "Afgørelse.pdf", cls: "letter", date: at("2026-11-01T00:00:00Z"), text: "Du kan klage over afgørelsen inden 2 uger." };
    const out = findContradictions({ id: "c2", kind: "reply", dueAt: "2026-11-15T22:59:00Z" }, [rule, letter]);
    expect(out).toHaveLength(1);
    expect(out[0].winner).toBeNull();
    expect(explainContradiction(out[0], "da")).toBe("Reglen (§ 16) siger 4 uger, „Afgørelse.pdf“ siger 2 uger. Tjek hvilken der gælder.");
  });

  it("proposes the newer letter's moved due date", () => {
    const first: Statement = { sourceId: "l1", title: "Indkaldelse", cls: "letter", date: at("2026-10-01T00:00:00Z"), text: "Skemaet skal indsendes senest 20. november 2026." };
    const second: Statement = { sourceId: "l2", title: "Ny frist", cls: "letter", date: at("2026-11-02T00:00:00Z"), text: "Vi har forlænget fristen. Ny frist: senest 27. november 2026." };
    const out = findContradictions({ id: "c3", kind: "form", dueAt: "2026-11-20T22:59:00Z" }, [first, second]);
    expect(out).toHaveLength(1);
    expect(out[0].winner?.sourceId).toBe("l2");
    expect(out[0].fix?.set).toEqual({ startAt: "2026-11-27T22:59:00.000Z", props: { dueAt: "2026-11-27T22:59:00.000Z" } });
  });

  it("ignores a letter that lists several unrelated deadlines, and amounts that agree", () => {
    const many: Statement = { sourceId: "m", title: "Info", cls: "letter", date: at("2026-11-01T00:00:00Z"), text: "Tilmelding senest 10. november. Betaling senest 24. november." };
    const one: Statement = { sourceId: "o", title: "Faktura", cls: "letter", date: at("2026-10-01T00:00:00Z"), text: "Betales senest 20. november. Beløb at betale: 1.250,00 kr" };
    const same: Statement = { sourceId: "s", title: "Mail", cls: "email", date: at("2026-10-05T00:00:00Z"), text: "Husk at betale 1.250 kr" };
    const out = findContradictions({ id: "c4", kind: "payment", dueAt: "2026-11-20T22:59:00Z", amount: { value: 1250, currency: "DKK" } }, [many, one, same]);
    expect(out).toEqual([]);
  });

  it("compares due dates only between the commitment's own sources and its thread, not the same sender's other letters", () => {
    const own: Statement = { sourceId: "o", title: "Svømning", cls: "chat", rel: "own", date: at("2026-11-01T00:00:00Z"), text: "Giv samtykke senest 9. november." };
    const other: Statement = { sourceId: "z", title: "Zoo trip", cls: "letter", rel: "party", date: at("2026-11-02T00:00:00Z"), text: "The permission slip must be returned by Monday 16 November 2026." };
    expect(findContradictions({ id: "c6", kind: "form", dueAt: "2026-11-09T11:00:00Z" }, [own, other])).toEqual([]);
  });

  it("flags amounts that disagree and fixes from the stronger source", () => {
    const invoice: Statement = { sourceId: "inv", title: "Faktura 2211", cls: "letter", date: at("2026-10-01T00:00:00Z"), text: "Beløb at betale: 1.350,00 kr" };
    const chat: Statement = { sourceId: "sms", title: "SMS", cls: "chat", date: at("2026-10-05T00:00:00Z"), text: "det er 1.250 kr i alt" };
    const out = findContradictions({ id: "c5", kind: "payment", dueAt: null, amount: { value: 1250, currency: "DKK" } }, [invoice, chat]);
    expect(out).toHaveLength(1);
    expect(out[0].fix?.set).toEqual({ props: { amount: { value: 1350, currency: "DKK" } } });
  });
});

describe("fulfilment", () => {
  const bill: FulfilCommitment = {
    id: "c", label: "Pay Vejle Vand's invoice", kind: "payment", direction: "owe", dueAt: at("2026-11-20T22:59:00Z"), appearedAt: at("2026-11-01T10:00:00Z"),
    amount: { value: 1250, currency: "DKK" }, counterparty: { names: ["Vejle Vand"], emails: ["kunde@vejlevand.dk"] }, threadKeys: [], ownSourceIds: ["inv"],
  };
  const ev = (p: Partial<Evidence>): Evidence => ({ sourceId: "r", title: "kvittering.txt", text: "", date: at("2026-11-10T09:00:00Z"), authoredByOwner: false, participants: [], threadKey: null, ...p });

  it("matches a Danish receipt by amount and payee", () => {
    const m = matchFulfilment(bill, ev({ text: "Kvittering for betaling\nModtager: Vejle Vand A/S\nBeløb: 1.250,00 kr\nDato: 10.11.2026" }));
    expect(m).toMatchObject({ commitmentId: "c", sourceId: "r", reasons: ["phrase", "counterparty", "amount"] });
    expect(m!.confidence).toBeGreaterThanOrEqual(0.8);
    expect(m!.quote).toContain("Kvittering");
  });

  it("matches an English payment confirmation", () => {
    expect(matchFulfilment(bill, ev({ text: "Payment received - thank you. Vejle Vand, DKK 1,250.00" }))).not.toBeNull();
  });

  it("refuses the wrong amount, reminders, requests, no payee, and outside the window", () => {
    expect(matchFulfilment(bill, ev({ text: "Kvittering. Vejle Vand. Beløb 1.350,00 kr" }))).toBeNull();
    expect(matchFulfilment(bill, ev({ text: "Rykker: Vejle Vand har ikke modtaget din betaling på 1.250,00 kr" }))).toBeNull();
    expect(matchFulfilment(bill, ev({ text: "Vejle Vand: 1.250,00 kr skal være betalt senest 20. november" }))).toBeNull();
    expect(matchFulfilment(bill, ev({ text: "Kvittering 1.250,00 kr" }))).toBeNull();
    expect(matchFulfilment(bill, ev({ text: "Kvittering Vejle Vand 1.250,00 kr", date: at("2026-02-01T00:00:00Z") }))).toBeNull();
    expect(matchFulfilment(bill, ev({ sourceId: "inv", text: "Kvittering Vejle Vand 1.250,00 kr" }))).toBeNull();
  });

  it("counts a reply the person sent to the other party after the request", () => {
    const reply: FulfilCommitment = { ...bill, kind: "reply", amount: null, label: "Reply to Vejle Kommune", counterparty: { names: ["Vejle Kommune"], emails: ["skole@vejle.dk"] } };
    const sent = ev({ text: "Hej, her er vores svar.", authoredByOwner: true, participants: [{ email: "anna@example.com", role: "from" }, { email: "skole@vejle.dk", role: "to" }] });
    expect(matchFulfilment(reply, sent)?.reasons).toContain("sent");
    // Their own mail to us is not our reply.
    expect(matchFulfilment(reply, { ...sent, authoredByOwner: false })).toBeNull();
    // A confirmation of receipt from them counts.
    expect(matchFulfilment(reply, ev({ text: "Tak for din henvendelse. Vejle Kommune" }))).not.toBeNull();
  });

  it("doesn't take a polite answer from the landlord as notice given, and knows a company without its suffix", () => {
    const notice: FulfilCommitment = { ...bill, kind: "notice", amount: null, label: "Give notice on the flat", counterparty: { names: ["Boligselskabet Fjordbo A/S"], emails: [] } };
    expect(matchFulfilment(notice, ev({ text: "Tak for din henvendelse. Du skal bare give 1 måneds varsel. Boligselskabet Fjordbo" }))).toBeNull();
    expect(matchFulfilment(notice, ev({ text: "Vi bekræfter din opsigelse af lejemålet. Boligselskabet Fjordbo" }))).not.toBeNull();
  });

  it("recognises done-phrases in both languages", () => {
    expect(donePhrase("Bogen er afleveret tilbage på biblioteket", "return")).not.toBeNull();
    expect(donePhrase("I returned it yesterday", "return")).not.toBeNull();
    expect(donePhrase("Tak for din ansøgning", "form")).not.toBeNull();
    expect(donePhrase("Skal være betalt senest fredag", "payment")).toBeNull();
  });

  it("closes an appointment by an event that happened with the other party", () => {
    const appt = { id: "a", kind: "appointment" as const, label: "Tandlæge for Emma", dueAt: at("2026-11-03T09:30:00Z"), counterparty: { names: ["Tandklinikken Vejle"], emails: [] } };
    expect(matchHappenedEvent(appt, { id: "e", label: "Tandlæge", start: at("2026-11-03T09:30:00Z"), end: null, involves: [], involvesNames: [] }, NOW)).not.toBeNull();
    expect(matchHappenedEvent(appt, { id: "e", label: "Tandlæge", start: at("2026-11-09T09:30:00Z"), end: null, involves: [], involvesNames: [] }, at("2026-11-10T00:00:00Z"))).toBeNull();
  });
});

describe("at risk", () => {
  const props = (p: Partial<CommitmentProps>): CommitmentProps => ({ direction: "owe", status: "open", kind: "notice", dueAt: "2026-11-10T22:59:00Z", dueKind: "deadline", ...p });

  it("is at risk within the lead time without a signal", () => {
    expect(assessRisk(props({}), "2026-10-01T00:00:00Z", null, NOW)).toMatchObject({ atRisk: true, reason: "no_progress", daysLeft: 5 });
  });

  it("a signal after it appeared takes it off the list; one before does not", () => {
    expect(assessRisk(props({}), "2026-10-01T00:00:00Z", { at: "2026-11-02T00:00:00Z" }, NOW)).toMatchObject({ atRisk: false, reason: "progress" });
    expect(assessRisk(props({}), "2026-10-01T00:00:00Z", { at: "2026-09-02T00:00:00Z" }, NOW).atRisk).toBe(true);
    expect(withSignal(props({}), "2026-10-01T00:00:00Z", { at: "2026-11-02T00:00:00Z" }).progressAt).toBe("2026-11-02T00:00:00.000Z");
  });

  it("is not at risk further out, for appointments, or when overdue", () => {
    expect(assessRisk(props({ dueAt: "2026-12-30T00:00:00Z" }), "2026-10-01", null, NOW).atRisk).toBe(false);
    expect(assessRisk(props({ kind: "appointment", dueAt: "2026-11-06T09:00:00Z" }), "2026-10-01", null, NOW).atRisk).toBe(false);
    expect(assessRisk(props({ dueAt: "2026-11-01T00:00:00Z" }), "2026-10-01", null, NOW).urgency).toBe("overdue");
  });
});

describe("morning summary", () => {
  const items = [
    { label: "Give notice on the car insurance", dueAt: "2026-11-10T22:59:00Z", urgency: "at_risk" as const, kind: "notice" as const },
    { label: "Pay Vejle Vand", dueAt: "2026-11-07T22:59:00Z", urgency: "this_week" as const, kind: "payment" as const },
    { label: "Emma: tandlæge", dueAt: "2026-11-09T09:30:00Z", urgency: "this_week" as const, kind: "appointment" as const },
    { label: "Renew passport", dueAt: "2027-03-01T00:00:00Z", urgency: "later" as const, kind: "renewal" as const },
  ];

  it("names the thing at risk (en)", () => {
    expect(morningSummary(items, "en", NOW)).toBe("3 things this week, 1 at risk: give notice on the car insurance (last day Tue).");
  });

  it("names the thing at risk (da)", () => {
    expect(morningSummary(items, "da", NOW)).toBe("3 ting i denne uge, 1 i fare: give notice on the car insurance (sidste dag tirs.).");
  });

  it("leads with overdue, and says when nothing is due", () => {
    const over = [{ label: "Betal tandlægen", dueAt: "2026-11-04T22:59:00Z", urgency: "overdue" as const, kind: "payment" as const }, ...items];
    expect(morningSummary(over, "da", NOW)).toBe("1 over fristen, 3 ting i denne uge, 1 i fare: betal tandlægen (fristen var i går).");
    expect(morningSummary([], "en", NOW)).toBe("Nothing due right now.");
    expect(morningSummary([items[3]], "da", NOW)).toBe("Intet med frist i denne uge (1 ting senere).");
    expect(morningSummary([items[1]], "en", NOW)).toBe("1 thing this week; next: pay Vejle Vand (last day Sat).");
  });
});
