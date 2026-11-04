import { describe, expect, it } from "vitest";
import {
  checkConsent, clinicalAccess, consentSummary, extractRiskFlags, isSignedOff, mayDo, nextStatus, normalizeIcd10, normalizeIcpc2,
  parseCodeSuggestions, parseLabValues, quoteFound, scoreMeasure, PURPOSE_OF, type ConsentRow,
} from "./pure";
import { signOffOps } from "./ops";

const now = new Date("2026-11-04T10:00:00Z");
const day = 24 * 3600 * 1000;
const consent = (p: Partial<ConsentRow> = {}): ConsentRow => ({
  id: "c1", purposes: ["recording", "transcription", "notes", "analysis", "sharing"], sharedWith: ["colleague-1"],
  signedAt: new Date(now.getTime() - 10 * day), reviewAt: new Date(now.getTime() + 300 * day), withdrawnAt: null, ...p,
});

describe("consent gating per purpose", () => {
  it("blocks every purpose without a consent", () => {
    for (const p of ["recording", "transcription", "notes", "analysis", "sharing"] as const) {
      const r = checkConsent([], p, now);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.problem).toBe("none");
    }
  });
  it("allows only the purposes the consent covers", () => {
    const c = [consent({ purposes: ["notes"] })];
    expect(checkConsent(c, "notes", now).ok).toBe(true);
    const rec = checkConsent(c, "recording", now);
    expect(rec.ok).toBe(false);
    if (!rec.ok) { expect(rec.problem).toBe("not_covered"); expect(rec.message).toMatch(/does not cover recording/); }
  });
  it("stops at the review date and on withdrawal", () => {
    const expired = checkConsent([consent({ reviewAt: new Date(now.getTime() - day) })], "notes", now);
    expect(expired.ok || expired.problem).toBe("expired");
    const withdrawn = checkConsent([consent({ withdrawnAt: new Date(now.getTime() - day) })], "recording", now);
    expect(withdrawn.ok || withdrawn.problem).toBe("withdrawn");
    expect(consentSummary([consent({ withdrawnAt: new Date(now.getTime() - day) })], now).allowed.analysis).toBe(false);
  });
  it("is not in force before it is signed", () => {
    const r = checkConsent([consent({ signedAt: new Date(now.getTime() + day) })], "notes", now);
    expect(r.ok || r.problem).toBe("not_yet_signed");
  });
  it("sharing needs the colleague named", () => {
    expect(checkConsent([consent()], "sharing", now, { colleagueId: "colleague-1" }).ok).toBe(true);
    const r = checkConsent([consent()], "sharing", now, { colleagueId: "colleague-2" });
    expect(r.ok || r.problem).toBe("colleague_not_named");
  });
  it("maps each kind of work to a purpose", () => {
    expect(PURPOSE_OF.record).toBe("recording");
    expect(PURPOSE_OF.transcribe).toBe("transcription");
    expect(PURPOSE_OF.codes).toBe("analysis");
    expect(PURPOSE_OF.share).toBe("sharing");
  });
  it("summarises review soon", () => {
    expect(consentSummary([consent({ reviewAt: new Date(now.getTime() + 5 * day) })], now).state).toBe("review_soon");
    expect(consentSummary([], now).state).toBe("none");
  });
});

describe("clinical access", () => {
  const me = { id: "clinician-1", graphId: "g1" };
  const client = { ownerId: "clinician-1", graphId: "g1" };
  it("the clinician who owns the client", () => {
    expect(clinicalAccess(me, client, [], [], now)).toBe("clinician");
  });
  it("denies a colleague the client isn't shared with", () => {
    expect(clinicalAccess({ id: "colleague-1", graphId: "g1" }, client, [], [consent()], now)).toBe(null);
  });
  it("denies a shared colleague the consent doesn't name", () => {
    expect(clinicalAccess({ id: "colleague-2", graphId: "g1" }, client, [{ expiresAt: null }], [consent()], now)).toBe(null);
  });
  it("allows a shared, named colleague to read but not write", () => {
    const a = clinicalAccess({ id: "colleague-1", graphId: "g1" }, client, [{ expiresAt: null }], [consent()], now);
    expect(a).toBe("colleague");
    expect(mayDo(a, "read")).toBe(true);
    expect(mayDo(a, "write")).toBe(false);
  });
  it("denies once sharing consent is withdrawn or the share expired", () => {
    expect(clinicalAccess({ id: "colleague-1", graphId: "g1" }, client, [{ expiresAt: null }], [consent({ withdrawnAt: new Date(now.getTime() - 1) })], now)).toBe(null);
    expect(clinicalAccess({ id: "colleague-1", graphId: "g1" }, client, [{ expiresAt: new Date(now.getTime() - 1) }], [consent()], now)).toBe(null);
  });
  it("never across graphs", () => {
    expect(clinicalAccess({ id: "clinician-1", graphId: "g2" }, client, [], [], now)).toBe(null);
  });
});

describe("risk flags", () => {
  it("finds suicide and self-harm mentions in English and Danish with the quote", () => {
    const text = "We talked about work. Sometimes I think everyone would be better off dead without me. Last week I was cutting myself again.\nJeg har tænkt på selvmord flere gange. Ellers går det fint.";
    const flags = extractRiskFlags(text);
    expect(flags.map((f) => f.category)).toEqual(["suicide", "self_harm", "suicide"]);
    expect(flags[0].quote).toBe("Sometimes I think everyone would be better off dead without me.");
    expect(flags[2].quote).toBe("Jeg har tænkt på selvmord flere gange.");
  });
  it("finds nothing in an ordinary session", () => {
    expect(extractRiskFlags("We talked about sleep and the new job. She feels calmer.")).toEqual([]);
  });
  it("gives the time from segments", () => {
    const flags = extractRiskFlags("I want to kill myself.", [{ start: 12.5, text: "I want to kill myself." }]);
    expect(flags[0].timeSec).toBe(12.5);
  });
});

describe("code suggestions", () => {
  const text = "Patienten har haft nedtrykthed og manglende lyst i seks uger. Sover dårligt. Blodtryk 150/95.";
  it("normalises codes", () => {
    expect(normalizeIcd10("DF321")).toBe("F32.1");
    expect(normalizeIcd10("f32.1")).toBe("F32.1");
    expect(normalizeIcd10("I10")).toBe("I10");
    expect(normalizeIcd10("depression")).toBe(null);
    expect(normalizeIcpc2("p 76")).toBe("P76");
    expect(normalizeIcpc2("K86")).toBe("K86");
    expect(normalizeIcpc2("C76")).toBe(null);
  });
  it("keeps only valid codes with evidence found in the text", () => {
    const raw = { codes: [
      { system: "ICD-10", code: "DF321", label: "Moderate depressive episode", evidence: ["nedtrykthed og manglende lyst i seks uger"], confidence: 0.7 },
      { system: "ICPC-2", code: "P76", label: "Depression", evidence: ["Sover dårligt"], confidence: 0.6 },
      { system: "ICD-10", code: "I10", label: "Hypertension", evidence: ["Blodtrykket har været højt i årevis"] },
      { system: "ICD-10", code: "XYZ", label: "Nonsense", evidence: ["Sover dårligt"] },
      { system: "ICD-10", code: "F32.1", label: "dup", evidence: ["Sover dårligt"], confidence: 0.4 },
    ] };
    const out = parseCodeSuggestions(raw, text);
    expect(out.map((c) => `${c.system} ${c.code}`)).toEqual(["ICD-10 F32.1", "ICPC-2 P76"]);
    expect(out[0].evidence).toHaveLength(2);
  });
  it("is empty for junk", () => {
    expect(parseCodeSuggestions("nope", text)).toEqual([]);
    expect(parseCodeSuggestions(null, text)).toEqual([]);
  });
});

describe("lab values", () => {
  it("reads values, units and ranges (Danish commas too)", () => {
    const text = [
      "Prøve taget 03.11.2026",
      "Hæmoglobin 8,1 mmol/L (7,3-9,5)",
      "HbA1c: 48 mmol/mol [20–42]",
      "P-Kreatinin 85 µmol/L 60 - 105",
      "ALAT 52 H U/L ref. 10-45",
      "Side 1 af 2",
      "TSH 0.2 mIU/L (0.3–4.0)",
    ].join("\n");
    const v = parseLabValues(text);
    expect(v.map((x) => [x.name, x.value, x.unit, x.refLow, x.refHigh, x.flag])).toEqual([
      ["Hæmoglobin", 8.1, "mmol/L", 7.3, 9.5, "normal"],
      ["HbA1c", 48, "mmol/mol", 20, 42, "high"],
      ["P-Kreatinin", 85, "µmol/L", 60, 105, "normal"],
      ["ALAT", 52, "U/L", 10, 45, "high"],
      ["TSH", 0.2, "mIU/L", 0.3, 4, "low"],
    ]);
  });
  it("ignores lines without a unit or range", () => {
    expect(parseLabValues("Dato 2026\nNavn Anna Hansen\nSee you in 3 weeks")).toEqual([]);
  });
});

describe("measures", () => {
  it("scores PHQ-9 and flags question 9", () => {
    expect(scoreMeasure("phq9", [1, 1, 2, 2, 1, 1, 1, 1, 0])).toEqual({ score: 10, band: "moderate", riskItem: false });
    expect(scoreMeasure("phq9", [3, 3, 3, 3, 3, 3, 3, 3, 1]).riskItem).toBe(true);
    expect(scoreMeasure("gad7", [0, 1, 1, 1, 1, 1, 0]).band).toBe("mild");
    expect(() => scoreMeasure("gad7", [1, 1])).toThrow();
  });
});

describe("nothing applied without sign-off", () => {
  it("only signed or confirmed items reach the graph", () => {
    expect(isSignedOff("proposed")).toBe(false);
    expect(isSignedOff("dismissed")).toBe(false);
    expect(isSignedOff("signed")).toBe(true);
    const base = { clientNodeId: "00000000-0000-4000-8000-000000000001", clientLabel: "Anna", sessionNodeId: null, discipline: "medical" as const };
    expect(signOffOps({ kind: "medication", status: "proposed", content: { name: "Sertraline" }, title: null }, base)).toEqual([]);
    expect(signOffOps({ kind: "code", status: "dismissed", content: { system: "ICD-10", code: "F32.1" }, title: null }, base)).toEqual([]);
    const ops = signOffOps({ kind: "medication", status: "confirmed", content: { name: "Sertraline", dose: "50 mg" }, title: null }, base);
    expect(ops.map((o) => o.op)).toEqual(["addNode", "addEdge"]);
  });
  it("notes are signed, suggestions confirmed, risks acknowledged", () => {
    expect(nextStatus("note", "proposed", "sign")).toBe("signed");
    expect(nextStatus("note", "proposed", "confirm")).toBe(null);
    expect(nextStatus("code", "proposed", "confirm")).toBe("confirmed");
    expect(nextStatus("code", "signed", "dismiss")).toBe(null);
    expect(nextStatus("risk", "open", "acknowledge")).toBe("acknowledged");
    expect(nextStatus("risk", "open", "dismiss")).toBe(null);
  });
  it("checks quotes against the source", () => {
    expect(quoteFound("Jeg sover  dårligt om natten.", "sover dårligt")).toBe(true);
    expect(quoteFound("Jeg sover dårligt.", "sover godt")).toBe(false);
  });
});

describe("days in a time zone", async () => {
  const { zonedDay } = await import("./pure");
  it("Copenhagen midnight in UTC (winter)", () => {
    const d = zonedDay(new Date("2026-11-04T10:00:00Z"), "Europe/Copenhagen");
    expect(d.from.toISOString()).toBe("2026-11-03T23:00:00.000Z");
    expect(d.to.toISOString()).toBe("2026-11-04T23:00:00.000Z");
  });
});
