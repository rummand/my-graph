/**
 * Clinical rules, pure (no DB, no Next) so the server, the client and the tests share one definition.
 *
 *  - Consent: a client's written consent covers named purposes. No valid consent for a purpose = that processing is
 *    blocked with a plain message. Withdrawal hides analysis and stops recording.
 *  - Access: the clinician who owns a client sees everything; a colleague only while the client node is shared with
 *    them AND a valid consent names them for sharing. Everyone else sees nothing.
 *  - Extraction helpers: risk mentions (with the quote), code suggestions (ICD-10, ICPC-2), lab values with reference
 *    ranges, PHQ-9 and GAD-7 scoring. Nothing here applies anything; it only reads and proposes.
 */
import { z } from "zod";

/* ── Disciplines and features ────────────────────────────────────────────────────────────────────────── */

export type Discipline = "psychology" | "medical";
export const DISCIPLINES: Discipline[] = ["psychology", "medical"];
export const FEATURE_OF: Record<Discipline, "practice_psychology" | "practice_medical"> = {
  psychology: "practice_psychology", medical: "practice_medical",
};
/** The person kind a discipline works with, and what one meeting is called. */
export const CLIENT_KIND: Record<Discipline, "client" | "patient"> = { psychology: "client", medical: "patient" };
export const MEETING_KIND: Record<Discipline, "session" | "consultation"> = { psychology: "session", medical: "consultation" };

export function disciplineOfKind(kind: string | null | undefined): Discipline | null {
  return kind === "client" ? "psychology" : kind === "patient" ? "medical" : null;
}

/* ── Consent ─────────────────────────────────────────────────────────────────────────────────────────── */

export type Purpose = "recording" | "transcription" | "notes" | "analysis" | "sharing";
export const PURPOSES: Purpose[] = ["recording", "transcription", "notes", "analysis", "sharing"];

export type ConsentRow = {
  id: string;
  purposes: string[];
  sharedWith: string[];
  signedAt: Date;
  reviewAt: Date | null;
  withdrawnAt: Date | null;
  documentSourceId?: string | null;
};

export type ConsentProblem = "none" | "not_yet_signed" | "expired" | "withdrawn" | "not_covered" | "colleague_not_named";

export type ConsentCheck =
  | { ok: true; consentId: string }
  | { ok: false; problem: ConsentProblem; purpose: Purpose; message: string };

const PURPOSE_WORDS: Record<Purpose, string> = {
  recording: "recording sessions",
  transcription: "transcribing recordings",
  notes: "writing notes from sessions",
  analysis: "analysing sessions (themes, hypotheses, codes, summaries)",
  sharing: "sharing the record with a colleague",
};

function blocked(purpose: Purpose, problem: ConsentProblem): ConsentCheck {
  const what = PURPOSE_WORDS[purpose];
  const message = {
    none: `There is no signed consent on file, so ${what} is not possible. Register the signed consent first.`,
    not_yet_signed: `The consent is dated in the future, so ${what} is not possible yet.`,
    expired: `The consent has passed its review date, so ${what} is paused. Renew the consent to continue.`,
    withdrawn: `The consent was withdrawn, so ${what} has stopped.`,
    not_covered: `The signed consent does not cover ${what}.`,
    colleague_not_named: "The consent does not name this colleague, so the record can't be shared with them.",
  }[problem];
  return { ok: false, problem, purpose, message };
}

/** Is this one consent in force at `now` (signed, not past review, not withdrawn)? */
export function consentInForce(c: ConsentRow, now = new Date()): boolean {
  if (c.withdrawnAt && c.withdrawnAt.getTime() <= now.getTime()) return false;
  if (c.signedAt.getTime() > now.getTime()) return false;
  if (c.reviewAt && c.reviewAt.getTime() <= now.getTime()) return false;
  return true;
}

/**
 * May this purpose go ahead? Any consent in force that covers the purpose allows it (and, for sharing, names the
 * colleague). When none does, the most telling problem is reported: withdrawn beats expired beats not covered.
 */
export function checkConsent(consents: ConsentRow[], purpose: Purpose, now = new Date(), opts: { colleagueId?: string } = {}): ConsentCheck {
  if (!consents.length) return blocked(purpose, "none");
  const live = consents.filter((c) => consentInForce(c, now));
  const covering = live.filter((c) => c.purposes.includes(purpose));
  if (covering.length) {
    if (purpose === "sharing" && opts.colleagueId) {
      const named = covering.find((c) => c.sharedWith.includes(opts.colleagueId!));
      return named ? { ok: true, consentId: named.id } : blocked(purpose, "colleague_not_named");
    }
    return { ok: true, consentId: covering[0].id };
  }
  if (live.length) return blocked(purpose, "not_covered");
  const latest = [...consents].sort((a, b) => b.signedAt.getTime() - a.signedAt.getTime())[0];
  if (latest.withdrawnAt && latest.withdrawnAt.getTime() <= now.getTime()) return blocked(purpose, "withdrawn");
  if (latest.signedAt.getTime() > now.getTime()) return blocked(purpose, "not_yet_signed");
  return blocked(purpose, "expired");
}

export type ConsentSummary = {
  state: "valid" | "review_soon" | "expired" | "withdrawn" | "none";
  allowed: Record<Purpose, boolean>;
  reviewAt: Date | null;
  sharedWith: string[];
};

/** One line of consent status for the top of a client page. Review within 30 days counts as "review soon". */
export function consentSummary(consents: ConsentRow[], now = new Date()): ConsentSummary {
  const allowed = Object.fromEntries(PURPOSES.map((p) => [p, checkConsent(consents, p, now).ok])) as Record<Purpose, boolean>;
  const live = consents.filter((c) => consentInForce(c, now));
  const sharedWith = [...new Set(live.filter((c) => c.purposes.includes("sharing")).flatMap((c) => c.sharedWith))];
  if (!consents.length) return { state: "none", allowed, reviewAt: null, sharedWith };
  if (!live.length) {
    const latest = [...consents].sort((a, b) => b.signedAt.getTime() - a.signedAt.getTime())[0];
    return { state: latest.withdrawnAt ? "withdrawn" : "expired", allowed, reviewAt: latest.reviewAt, sharedWith };
  }
  const reviews = live.map((c) => c.reviewAt).filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime());
  const reviewAt = reviews[0] ?? null;
  const soon = !!reviewAt && reviewAt.getTime() - now.getTime() < 30 * 24 * 3600 * 1000;
  return { state: soon ? "review_soon" : "valid", allowed, reviewAt, sharedWith };
}

/** Which consent purpose each kind of work needs. */
export const PURPOSE_OF = {
  record: "recording",
  upload_audio: "recording",
  transcribe: "transcription",
  dictate: "notes",
  draft_note: "notes",
  risk_scan: "notes",
  medications: "notes",
  labs: "notes",
  letter: "notes",
  followups: "notes",
  measure: "notes",
  themes: "analysis",
  hypotheses: "analysis",
  codes: "analysis",
  summary: "analysis",
  share: "sharing",
} as const satisfies Record<string, Purpose>;
export type Work = keyof typeof PURPOSE_OF;

/* ── Access ──────────────────────────────────────────────────────────────────────────────────────────── */

export type ClinicalAccess = "clinician" | "colleague" | null;

/**
 * Who may open a client's record. `client` is the client's node; `shares` are the viewer's share rows on it.
 * The clinician (the node's owner) always; a colleague only with an active share AND a consent in force that names them
 * for sharing; nobody outside the practice graph.
 */
export function clinicalAccess(
  viewer: { id: string; graphId: string },
  client: { ownerId: string; graphId: string },
  shares: { expiresAt: Date | null }[],
  consents: ConsentRow[],
  now = new Date(),
): ClinicalAccess {
  if (client.graphId !== viewer.graphId) return null;
  if (client.ownerId === viewer.id) return "clinician";
  const shared = shares.some((s) => s.expiresAt === null || s.expiresAt.getTime() > now.getTime());
  if (!shared) return null;
  return checkConsent(consents, "sharing", now, { colleagueId: viewer.id }).ok ? "colleague" : null;
}

/** What each level may do. Colleagues read; only the clinician records, drafts, signs and changes consent. */
export function mayDo(access: ClinicalAccess, action: "read" | "write"): boolean {
  if (!access) return false;
  return action === "read" || access === "clinician";
}

/* ── Item kinds and statuses ─────────────────────────────────────────────────────────────────────────── */

export const ITEM_KINDS = [
  "note", "letter", "summary", "theme", "hypothesis", "risk", "code", "medication", "allergy", "lab", "measure", "followup",
] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/** Items that are analysis: hidden when the analysis consent is not in force. */
export const ANALYSIS_KINDS: ItemKind[] = ["theme", "hypothesis", "code", "summary"];

export type ItemStatus = "proposed" | "signed" | "confirmed" | "dismissed" | "open" | "acknowledged" | "done";
export type Decision = "sign" | "confirm" | "dismiss" | "acknowledge" | "reopen" | "complete";

/** May a proposed item reach the graph? Only after a person signed or confirmed it. */
export function isSignedOff(status: string): boolean {
  return status === "signed" || status === "confirmed";
}

/** The next status for a decision on an item, or null when the decision doesn't fit its kind/status. */
export function nextStatus(kind: ItemKind, status: string, decision: Decision): ItemStatus | null {
  const signable = kind === "note" || kind === "letter";
  if (decision === "complete") return kind === "followup" && status === "confirmed" ? "done" : null;
  if (decision === "acknowledge") return kind === "risk" && status === "open" ? "acknowledged" : null;
  if (kind === "risk") return null;
  if (decision === "reopen") return status === "dismissed" ? "proposed" : null;
  if (status !== "proposed") return null;
  if (decision === "dismiss") return "dismissed";
  if (decision === "sign") return signable ? "signed" : null;
  if (decision === "confirm") return signable || kind === "summary" ? null : "confirmed";
  return null;
}

/* ── Notes ───────────────────────────────────────────────────────────────────────────────────────────── */

export const NOTE_SECTIONS: Record<Discipline, string[]> = {
  psychology: ["subjective", "objective", "assessment", "plan"],
  medical: ["history", "findings", "assessment", "plan"],
};

export const noteContent = z.object({
  sections: z.record(z.string().max(40), z.string().max(20_000)),
  /** Free text the clinician adds under the sections. */
  extra: z.string().max(20_000).optional(),
});
export type NoteContent = z.infer<typeof noteContent>;

/** Section headings in the note's language (the signed text is written with these). */
export const NOTE_HEADINGS: Record<"da" | "en", Record<string, string>> = {
  en: { subjective: "Subjective", objective: "Objective", assessment: "Assessment", plan: "Plan", history: "History", findings: "Findings" },
  da: { subjective: "Subjektivt", objective: "Objektivt", assessment: "Vurdering", plan: "Plan", history: "Anamnese", findings: "Objektive fund" },
};

/** A note as plain text (sections in order, with their headings). */
export function noteText(discipline: Discipline, c: NoteContent, headings: Record<string, string>): string {
  const parts = NOTE_SECTIONS[discipline].map((k) => (c.sections[k]?.trim() ? `${headings[k] ?? k}\n${c.sections[k].trim()}` : "")).filter(Boolean);
  if (c.extra?.trim()) parts.push(c.extra.trim());
  return parts.join("\n\n");
}

/* ── Quotes ──────────────────────────────────────────────────────────────────────────────────────────── */

const norm = (s: string) => s.toLowerCase().replace(/[“”"„«»]/g, "\"").replace(/[‘’`´]/g, "'").replace(/\s+/g, " ").trim();

/** Does the quote really occur in the text? (case, quote marks and whitespace don't matter; "…" splits fragments) */
export function quoteFound(text: string, quote: string): boolean {
  const q = norm(quote).replace(/^["']|["']$/g, "");
  if (q.length < 3) return false;
  const t = norm(text);
  return q.split(/\s*(?:…|\.\.\.)\s*/).filter((f) => f.length >= 3).every((f) => t.includes(f));
}

/** The sentence around a position in a text (at most `max` characters). */
export function sentenceAround(text: string, at: number, max = 300): string {
  const before = text.slice(0, at);
  const start = Math.max(before.search(/[^.!?\n]*$/), 0);
  const rest = text.slice(at);
  const endRel = rest.search(/[.!?\n]/);
  const end = endRel < 0 ? text.length : at + endRel + 1;
  let s = text.slice(start, end).trim();
  if (s.length > max) {
    const from = Math.max(0, at - start - Math.floor(max / 2));
    s = `…${s.slice(from, from + max).trim()}…`;
  }
  return s;
}

/* ── Risk flags ──────────────────────────────────────────────────────────────────────────────────────── */

export type RiskCategory = "suicide" | "self_harm" | "harm_to_others";
export type RiskFlag = { category: RiskCategory; quote: string; index: number; timeSec?: number | null };

const RISK_PATTERNS: { category: RiskCategory; re: RegExp }[] = [
  {
    category: "suicide",
    re: /(suicid\w*|kill(?:ing)? (?:my|him|her)sel(?:f|ves)|end(?:ing)? (?:my|his|her|it all|my own) ?life|end it all|take (?:my|his|her) (?:own )?life|(?:don'?t|do not) want to (?:live|be alive|be here|wake up)|better off dead|wish (?:I|he|she) (?:was|were) dead|selvmord\w*|tage (?:mit|sit) (?:eget )?liv|slå mig selv ihjel|gøre en ende på det|(?:vil|ønsker at|har lyst til at) dø\b|ikke (?:vil|orker at|gider) (?:leve|være her) (?:mere|længere)|have det bedre død)/gi,
  },
  {
    category: "self_harm",
    re: /(self[- ]?harm\w*|cut(?:ting|s)? (?:my|him|her)sel(?:f|ves)|hurt(?:ing|s)? (?:my|him|her)sel(?:f|ves)|burn(?:ing|s)? (?:my|him|her)sel(?:f|ves)|selvskad\w*|skær(?:e|er|te) (?:i )?(?:mig|sig) selv|cutter (?:mig|sig)|brænd(?:e|er|te) (?:mig|sig) selv|gør (?:mig|sig) selv fortræd|gøre (?:mig|sig) selv (?:skade|fortræd))/gi,
  },
  {
    category: "harm_to_others",
    re: /(kill (?:him|her|them|someone|somebody)|hurt (?:him|her|them|someone|somebody) badly|slå (?:ham|hende|dem|nogen) ihjel|gøre (?:ham|hende|dem|nogen) (?:alvorlig )?fortræd)/gi,
  },
];

/**
 * Mentions of suicide, self-harm or harm to others, each with the sentence it was said in. A mention is surfaced, not
 * judged: "I have never thought about suicide" is shown too, and the clinician decides. Segments (with times) give the
 * moment in the recording.
 */
export function extractRiskFlags(text: string, segments: { start: number; text: string }[] = []): RiskFlag[] {
  const out: RiskFlag[] = [];
  const seen = new Set<string>();
  for (const { category, re } of RISK_PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const quote = sentenceAround(text, m.index);
      const key = `${category}:${norm(quote)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const seg = segments.find((s) => s.text && norm(s.text).includes(norm(m![0])) && quoteFound(quote, s.text.slice(0, 60)));
      out.push({ category, quote, index: m.index, timeSec: seg ? seg.start : null });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

/* ── Measures: PHQ-9 and GAD-7 ───────────────────────────────────────────────────────────────────────── */

export type Instrument = "phq9" | "gad7";
export const INSTRUMENTS: Record<Instrument, { label: string; items: number; max: number; bands: [number, string][] }> = {
  phq9: { label: "PHQ-9", items: 9, max: 27, bands: [[0, "minimal"], [5, "mild"], [10, "moderate"], [15, "moderately_severe"], [20, "severe"]] },
  gad7: { label: "GAD-7", items: 7, max: 21, bands: [[0, "minimal"], [5, "mild"], [10, "moderate"], [15, "severe"]] },
};

export function scoreMeasure(instrument: Instrument, answers: number[]): { score: number; band: string; riskItem: boolean } {
  const def = INSTRUMENTS[instrument];
  if (answers.length !== def.items) throw new Error(`${def.label} has ${def.items} questions; got ${answers.length} answers.`);
  if (answers.some((a) => !Number.isInteger(a) || a < 0 || a > 3)) throw new Error("Every answer is 0, 1, 2 or 3.");
  const score = answers.reduce((s, a) => s + a, 0);
  let band = def.bands[0][1];
  for (const [from, name] of def.bands) if (score >= from) band = name;
  // PHQ-9 question 9: thoughts that you would be better off dead, or of hurting yourself.
  return { score, band, riskItem: instrument === "phq9" && answers[8] > 0 };
}

/** Points for a trend chart: oldest first, one per date. */
export function trend<T extends { at: Date; value: number }>(points: T[]): T[] {
  return [...points].sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** Out of range? */
export function rangeFlag(value: number, low: number | null | undefined, high: number | null | undefined): "low" | "high" | "normal" | null {
  if (low == null && high == null) return null;
  if (low != null && value < low) return "low";
  if (high != null && value > high) return "high";
  return "normal";
}

/* ── Codes: ICD-10 and ICPC-2 ────────────────────────────────────────────────────────────────────────── */

export type CodeSystem = "ICD-10" | "ICPC-2";
export type CodeSuggestion = { system: CodeSystem; code: string; label: string; evidence: string[]; confidence: number };

/** "F32.1", "DF321" (Danish SKS) → "F32.1"; null when it isn't an ICD-10 code. */
export function normalizeIcd10(raw: string): string | null {
  let s = raw.trim().toUpperCase().replace(/\s+/g, "");
  if (/^D[A-Z]\d{2,4}$/.test(s)) s = s.slice(1); // SKS prefix
  const m = /^([A-Z]\d{2})\.?(\d{1,2})?$/.exec(s);
  if (!m || m[1][0] === "U") return null;
  return m[2] ? `${m[1]}.${m[2]}` : m[1];
}

const ICPC_CHAPTERS = "ABDFHKLNPRSTUWXYZ";
/** "P76", "p 76", "T90.02" → "P76" / "T90.02"; null when it isn't an ICPC-2 code. */
export function normalizeIcpc2(raw: string): string | null {
  const s = raw.trim().toUpperCase().replace(/[\s-]+/g, "");
  const m = /^([A-Z])(\d{2})(\.\d{1,2})?$/.exec(s);
  if (!m || !ICPC_CHAPTERS.includes(m[1])) return null;
  const n = Number(m[2]);
  if (n < 1 || n > 99) return null;
  return `${m[1]}${m[2]}${m[3] ?? ""}`;
}

/**
 * The model's code suggestions → checked suggestions: valid codes only, deduplicated, and only with at least one
 * quote that really is in the source text (no evidence, no suggestion).
 */
export function parseCodeSuggestions(raw: unknown, sourceText: string): CodeSuggestion[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as { codes?: unknown }).codes) ? (raw as { codes: unknown[] }).codes : [];
  const out = new Map<string, CodeSuggestion>();
  for (const r of list as Record<string, unknown>[]) {
    if (!r || typeof r !== "object") continue;
    const sys = String(r.system ?? "").toUpperCase().replace(/\s/g, "");
    const system: CodeSystem | null = sys.startsWith("ICD") ? "ICD-10" : sys.startsWith("ICPC") ? "ICPC-2" : null;
    if (!system || typeof r.code !== "string") continue;
    const code = system === "ICD-10" ? normalizeIcd10(r.code) : normalizeIcpc2(r.code);
    if (!code) continue;
    const quotes = (Array.isArray(r.evidence) ? r.evidence : typeof r.evidence === "string" ? [r.evidence] : [])
      .filter((q): q is string => typeof q === "string" && quoteFound(sourceText, q)).map((q) => q.trim().slice(0, 400));
    if (!quotes.length) continue;
    const label = typeof r.label === "string" ? r.label.trim().slice(0, 200) : "";
    const confidence = typeof r.confidence === "number" && r.confidence >= 0 && r.confidence <= 1 ? r.confidence : 0.5;
    const key = `${system}:${code}`;
    const had = out.get(key);
    if (had) { had.evidence = [...new Set([...had.evidence, ...quotes])].slice(0, 5); had.confidence = Math.max(had.confidence, confidence); continue; }
    out.set(key, { system, code, label, evidence: quotes.slice(0, 5), confidence });
  }
  return [...out.values()].sort((a, b) => b.confidence - a.confidence);
}

/* ── Lab values ──────────────────────────────────────────────────────────────────────────────────────── */

export type LabValue = {
  name: string; value: number; unit: string | null; refLow: number | null; refHigh: number | null;
  flag: "low" | "high" | "normal" | null; quote: string;
};

const num = (s: string) => Number(s.replace(",", "."));
const NUMBER = String.raw`\d+(?:[.,]\d+)?`;
const UNIT = String.raw`(?:[a-zA-Zµμ%][\w/µμ%.^*×·⁹¹²³-]*(?:/[\w.µμ^*-]+)?)`;
const LAB_LINE = new RegExp(
  String.raw`^\s*(?<name>[A-Za-zÆØÅæøåÄÖÜäöü][A-Za-zÆØÅæøåÄÖÜäöü0-9 .,'()\-/]{0,48}?)\s*[:=]?\s+` +
  String.raw`(?:(?<flagPre>[HL*↑↓])\s+)?(?<value>${NUMBER})\s*(?<flagPost>[HL*↑↓](?=\s))?\s*(?<unit>${UNIT})?` +
  String.raw`\s*(?:(?:[(\[]\s*)?(?:ref(?:erence)?(?:\s*interval|\s*range)?\.?:?\s*|ref\.?\s*int\.?:?\s*|normal(?:område)?:?\s*)?(?<lo>${NUMBER})\s*[-–—]\s*(?<hi>${NUMBER})\s*(?:${UNIT})?\s*[)\]]?)?` +
  String.raw`\s*(?:[HL*↑↓])?\s*$`,
);
/** Units that make a value a measurement even without a reference range. */
const LAB_UNIT = /\/|%|^(?:mmol|µmol|μmol|nmol|pmol|mol|g|mg|µg|μg|ng|pg|mu|miu|iu|kiu|u|ku|mmhg|kpa|bpm|fl|kg|cm|mm|°c|x10|e9|e12|mekv|meq|ratio|sek|s)$/i;
const NOT_A_LAB = /^(date|dato|page|side|tel|phone|cpr|patient|name|navn|født|born|age|alder|id|nr|no|ref|svar|answer|prøve|sample|taken|udtaget|time|tid|klokken)\b/i;

/**
 * Lab values from the text of an uploaded result: one per line, "Hæmoglobin 8,1 mmol/L (7,3-9,5)", "HbA1c: 48 mmol/mol
 * [20–42]", "P-Kreatinin 85 µmol/L 60 - 105", "ALAT 52 H U/L ref. 10-45". A line counts only with a unit or a
 * reference range (so dates and page numbers are not values). Danish decimal commas are read.
 */
export function parseLabValues(text: string): LabValue[] {
  const out: LabValue[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\t+/g, "  ").trim();
    if (!line || line.length > 160) continue;
    const m = LAB_LINE.exec(line);
    if (!m?.groups) continue;
    const g = m.groups;
    const name = g.name.trim().replace(/[\s:.,-]+$/, "");
    if (!name || NOT_A_LAB.test(name) || !/[A-Za-zÆØÅæøå]{2}/.test(name)) continue;
    const unit = g.unit ? g.unit.trim() : null;
    const hasRange = g.lo !== undefined && g.hi !== undefined;
    if (!unit && !hasRange) continue;
    if (!hasRange && !LAB_UNIT.test(unit ?? "")) continue;
    if (unit && /^\d/.test(unit)) continue;
    const value = num(g.value);
    const refLow = hasRange ? num(g.lo) : null;
    const refHigh = hasRange ? num(g.hi) : null;
    if (refLow !== null && refHigh !== null && refLow > refHigh) continue;
    out.push({ name, value, unit, refLow, refHigh, flag: rangeFlag(value, refLow, refHigh), quote: line });
  }
  return out;
}

/* ── Model output (parsed defensively; quotes are checked against the source) ────────────────────────── */

const s = (max: number) => z.string().trim().max(max);
const quotes = z.array(z.string()).max(10).catch([]);

export const notesDraftSchema = z.object({
  note: z.record(z.string(), z.string()).catch({}),
  risks: z.array(z.object({ category: z.string(), quote: z.string() })).max(20).catch([]),
  followups: z.array(z.object({ title: s(200), dueInDays: z.number().int().min(0).max(730).nullish(), why: s(400).nullish() })).max(10).catch([]),
  medications: z.array(z.object({ name: s(120), dose: s(120).nullish(), frequency: s(120).nullish(), change: s(60).nullish(), quote: z.string().nullish() })).max(30).catch([]),
  allergies: z.array(z.object({ substance: s(120), reaction: s(200).nullish(), quote: z.string().nullish() })).max(20).catch([]),
});
export type NotesDraft = z.infer<typeof notesDraftSchema>;

export const analysisDraftSchema = z.object({
  themes: z.array(z.object({ label: s(120), quotes })).max(12).catch([]),
  hypotheses: z.array(z.object({ statement: s(500), evidence: quotes, against: quotes.optional(), confidence: z.number().min(0).max(1).nullish() })).max(8).catch([]),
  codes: z.array(z.unknown()).max(20).catch([]),
});
export type AnalysisDraft = z.infer<typeof analysisDraftSchema>;

/** Keep only quotes that are really in the text; drop entries left without any. */
export function verifiedQuotes(text: string, list: string[]): string[] {
  return [...new Set(list.filter((q) => typeof q === "string" && quoteFound(text, q)).map((q) => q.trim().slice(0, 400)))];
}

/** Follow-up due date from "in N days". */
export function dueFrom(base: Date, days: number | null | undefined): Date {
  const d = new Date(base.getTime());
  d.setUTCDate(d.getUTCDate() + (days ?? 14));
  d.setUTCHours(8, 0, 0, 0);
  return d;
}

/** Letter kinds the medical side drafts. */
export const LETTER_KINDS = ["referral", "discharge", "patient"] as const;
export type LetterKind = (typeof LETTER_KINDS)[number];

/* ── Days in the clinician's time zone ───────────────────────────────────────────────────────────────── */

function zoneOffsetMs(at: Date, timeZone: string): number {
  const local = new Date(at.toLocaleString("en-US", { timeZone }));
  const utc = new Date(at.toLocaleString("en-US", { timeZone: "UTC" }));
  return local.getTime() - utc.getTime();
}

/** Start and end (exclusive) of the day `now` falls on, in `timeZone`, as UTC instants. */
export function zonedDay(now: Date, timeZone: string): { from: Date; to: Date } {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const midnightUtc = new Date(`${ymd}T00:00:00Z`);
  const from = new Date(midnightUtc.getTime() - zoneOffsetMs(midnightUtc, timeZone));
  const next = new Date(midnightUtc.getTime() + 36 * 3600 * 1000);
  const nextYmd = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(next);
  const nextMid = new Date(`${nextYmd}T00:00:00Z`);
  return { from, to: new Date(nextMid.getTime() - zoneOffsetMs(nextMid, timeZone)) };
}
