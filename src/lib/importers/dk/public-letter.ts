/**
 * Danish public letters (pure): a PDF saved from mit.dk / e-Boks or shared from the iPhone, read for who sent it
 * (Skattestyrelsen, Udbetaling Danmark, a kommune, a region or hospital, a "Styrelsen for …", a school), what kind of
 * letter it is, and its deadlines ("frist", "senest den …", "svarfrist", "betalingsfrist", an indkaldelse's time).
 * Deadlines become reminder proposals and the sender an organization, each with the line it came from as receipt.
 * The model may read the same letter too; these are the certain parts, found without it (and when mux is down).
 */
import type { ChangeInput } from "@/lib/changes";
import { matchByLabel, normName } from "../match";
import type { ImportKnown } from "../types";
import { dkRe, findAuthorities, type Authority, type AuthorityKind } from "./authorities";
import { DATE_SOURCE, copenhagenToIso, dateAtStart, findDates, isoDay, sayDay, type DkDate } from "./dates";

export type LetterType =
  | "decision" | "hearing" | "summons" | "tax_assessment" | "preliminary_tax" | "payment" | "reminder" | "receipt"
  | "confirmation" | "school_enrolment" | "referral" | "appointment" | "letter";

export type DeadlineKind = "reply" | "payment" | "complaint" | "appointment" | "deadline";

export type Deadline = { kind: DeadlineKind; date: DkDate; quote: string; page?: number };

export type PublicLetter = {
  authority: Authority;
  type: LetterType;
  deadlines: Deadline[];
  /** Deadlines found but already well past when the letter was read (an old letter): not proposed. */
  stale: number;
};

export type LetterSegment = { text: string; page?: number };

const TYPES: { re: RegExp; type: LetterType }[] = [
  { re: dkRe(String.raw`\bårsopgørelse`, "i"), type: "tax_assessment" },
  { re: dkRe(String.raw`\bforskudsopgørelse`, "i"), type: "preliminary_tax" },
  { re: dkRe(String.raw`\bpartshøring`, "i"), type: "hearing" },
  { re: dkRe(String.raw`\bindkaldelse\b`, "i"), type: "summons" },
  { re: dkRe(String.raw`\bskoleindskrivning|\bindskrivning\s+til\s+(?:skole|børnehaveklasse)`, "i"), type: "school_enrolment" },
  { re: dkRe(String.raw`\bhenvisning\b`, "i"), type: "referral" },
  { re: dkRe(String.raw`\b(?:opkrævning|betalingsfrist|indbetalingskort|indbetal)`, "i"), type: "payment" },
  { re: dkRe(String.raw`\b(?:rykker|påmindelse)\b`, "i"), type: "reminder" },
  { re: dkRe(String.raw`\bafgørelse\b`, "i"), type: "decision" },
  { re: dkRe(String.raw`\b(?:din\s+tid|aftale\s+om\s+tid|tidsbestilling|mødetid|du\s+har\s+fået\s+en\s+tid)\b`, "i"), type: "appointment" },
  { re: dkRe(String.raw`\bkvittering\b`, "i"), type: "receipt" },
  { re: dkRe(String.raw`\bbekræftelse\b`, "i"), type: "confirmation" },
];

/** What makes a page a letter from a public body rather than any PDF naming a kommune. */
const LETTER_SIGNALS = [
  dkRe(String.raw`\bsags(?:nummer|nr\.?)`, "i"), dkRe(String.raw`\bj\.\s?nr\.?|\bjournalnummer`, "i"), dkRe(String.raw`\bcvr(?:-?nr\.?|-?nummer)?\b`, "i"), dkRe(String.raw`\bmed\s+venlig\s+hilsen|\bvenlig\s+hilsen`, "i"),
  dkRe(String.raw`\bkære\s+\p{Lu}`), dkRe(String.raw`\bafgørelse\b`, "i"), dkRe(String.raw`\bvi\s+skriver\s+til\s+dig|\bdu\s+får\s+dette\s+brev`, "i"), dkRe(String.raw`\bklagevejledning`, "i"),
  dkRe(String.raw`\bpartshøring|\bindkaldelse\b|\bårsopgørelse|\bforskudsopgørelse`, "i"), dkRe(String.raw`\bdigital\s+post\b`, "i"), dkRe(String.raw`\bse\s+vedlagte|\bbilag\b`, "i"),
];

const LETTER_TYPE_LABEL: Record<LetterType, { en: string; da: string }> = {
  decision: { en: "decision", da: "afgørelse" }, hearing: { en: "consultation (partshøring)", da: "partshøring" },
  summons: { en: "summons", da: "indkaldelse" }, tax_assessment: { en: "tax assessment (årsopgørelse)", da: "årsopgørelse" },
  preliminary_tax: { en: "preliminary tax (forskudsopgørelse)", da: "forskudsopgørelse" }, payment: { en: "payment request", da: "opkrævning" },
  reminder: { en: "reminder", da: "rykker" }, receipt: { en: "receipt", da: "kvittering" }, confirmation: { en: "confirmation", da: "bekræftelse" },
  school_enrolment: { en: "school enrolment", da: "skoleindskrivning" }, referral: { en: "referral", da: "henvisning" },
  appointment: { en: "appointment", da: "aftale" }, letter: { en: "letter", da: "brev" },
};

export const letterTypeLabel = (t: LetterType, locale: "en" | "da") => LETTER_TYPE_LABEL[t][locale];

/** Words that put a deadline (or a time) before a date. Group 1 = the word, which says what kind. */
const DEADLINE_LEADS = String.raw`(svarfrist|betalingsfrist|klagefrist|tidsfrist|ansøgningsfrist|fristen|frist|senest|inden|mødetid|tidspunkt|du\s+har\s+tid|din\s+tid)`;

/** How far after the lead word its date may be ("fristen for at sende dokumentationen er den …"). */
const LEAD_REACH = 90;

/** The date a lead word points at: the first date after it, in the same sentence and close by. */
function dateAfter(text: string, from: number): DkDate | null {
  const window = text.slice(from, from + LEAD_REACH + 40);
  const d = findDates(window)[0];
  if (!d || d.index > LEAD_REACH) return null;
  const gap = window.slice(0, d.index);
  if (/\n|[.!?]\s+\p{Lu}|[.!?]\s*$/u.test(gap.replace(/\b(?:kl|d|ca|nr|jf)\.\s*$/i, ""))) return null;
  return d;
}

function sentenceAround(text: string, index: number, len: number): string {
  let start = index;
  while (start > 0 && index - start < 160 && !/[.!?\n]/.test(text[start - 1])) start--;
  let end = index + len;
  while (end < text.length && end - index < 200 && !/[.!?\n]/.test(text[end])) end++;
  return text.slice(start, Math.min(text.length, end + 1)).replace(/\s+/g, " ").trim().slice(0, 300);
}

function kindOf(lead: string, sentence: string, type: LetterType): DeadlineKind {
  const l = lead.toLowerCase();
  if (/mødetid|tidspunkt|møde|tid\b|din tid|du har tid/.test(l)) return "appointment";
  if (l.startsWith("betalingsfrist") || /\b(?:betal|indbetal|beløbet|kr\.|opkrævning)/i.test(sentence)) return "payment";
  if (l.startsWith("klagefrist") || /\bklage/i.test(sentence)) return "complaint";
  if (l.startsWith("svarfrist") || /\b(?:svar|bemærkninger|indsend|send\s+os|kontakt\s+os|tilmeld|udfyld)/i.test(sentence) || type === "hearing") return "reply";
  return "deadline";
}

/** The deadlines in a letter's text, in order, each once per day and kind. */
export function findDeadlines(segments: LetterSegment[], type: LetterType): Deadline[] {
  const out: Deadline[] = [];
  const seen = new Set<string>();
  for (const seg of segments) {
    const re = new RegExp(`(?<![\\p{L}])${DEADLINE_LEADS}(?![\\p{L}])`, "giu");
    for (let m = re.exec(seg.text); m; m = re.exec(seg.text)) {
      const date = dateAfter(seg.text, m.index + m[0].length);
      if (!date) continue;
      const sentence = sentenceAround(seg.text, m.index, m[0].length + date.index + date.text.length);
      const kind = kindOf(m[1], sentence, type);
      const key = `${kind}|${isoDay(date)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind, date, quote: sentence, ...(seg.page ? { page: seg.page } : {}) });
    }
    // An indkaldelse names its time as "… den 3. marts 2027 kl. 10.30" without a lead word.
    if (type === "summons" || type === "appointment") {
      const re = new RegExp(`(?:den\\s+)?${DATE_SOURCE}`, "giu");
      for (let m = re.exec(seg.text); m; m = re.exec(seg.text)) {
        const date = dateAtStart(m[0]);
        if (!date || date.hour === undefined) continue;
        const key = `appointment|${isoDay(date)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ kind: "appointment", date, quote: sentenceAround(seg.text, m.index, m[0].length), ...(seg.page ? { page: seg.page } : {}) });
      }
    }
  }
  return out;
}

function letterTypeOf(text: string): LetterType {
  for (const t of TYPES) if (t.re.test(text)) return t.type;
  return "letter";
}

/**
 * The public letter this document is, or null. Its sender must be named in the first page (or first 2,500
 * characters) and the text must read like a letter (case number, "Med venlig hilsen", "Kære …", a decision …).
 */
export function classifyPublicLetter(segments: LetterSegment[], now: Date): PublicLetter | null {
  const full = segments.map((s) => s.text).join("\n\n");
  if (full.trim().length < 80) return null;
  const head = (segments[0]?.page ? segments.filter((s) => s.page === segments[0].page).map((s) => s.text).join("\n") : full).slice(0, 2500);
  const authorities = findAuthorities(head, { schools: true });
  if (!authorities.length) return null;
  const sample = full.slice(0, 8000);
  const signals = LETTER_SIGNALS.filter((re) => re.test(sample)).length;
  const official = authorities.find((a) => a.kind !== "school");
  const authority = official ?? authorities[0];
  if (signals < (official ? 1 : 2)) return null;
  const type = letterTypeOf(sample);
  const all = findDeadlines(segments, type);
  const cutoff = now.getTime() - 14 * 86400_000;
  const deadlines = all.filter((d) => Date.UTC(d.date.year, d.date.month - 1, d.date.day, 23) >= cutoff).slice(0, 6);
  return { authority, type, deadlines, stale: all.length - deadlines.length };
}

const KIND_LABEL: Record<AuthorityKind, { en: string; da: string }> = {
  tax: { en: "Tax authority", da: "Skattemyndighed" }, benefits: { en: "Public benefits", da: "Offentlige ydelser" },
  municipality: { en: "Municipality", da: "Kommune" }, region: { en: "Region", da: "Region" }, hospital: { en: "Hospital", da: "Hospital" },
  agency: { en: "Public agency", da: "Styrelse" }, police: { en: "Police", da: "Politi" }, school: { en: "School", da: "Skole" },
  pension: { en: "Pension", da: "Pension" }, court: { en: "Family law agency", da: "Familieret" },
};

function reminderTitle(d: Deadline, who: string, locale: "en" | "da"): string {
  const day = sayDay(d.date, locale);
  const time = d.date.hour !== undefined ? `${String(d.date.hour).padStart(2, "0")}.${String(d.date.minute ?? 0).padStart(2, "0")}` : null;
  if (locale === "da") {
    switch (d.kind) {
      case "reply": return `Svar ${who} senest ${day}`;
      case "payment": return `Betal til ${who} senest ${day}`;
      case "complaint": return `Sidste frist for at klage til ${who}: ${day}`;
      case "appointment": return `Tid hos ${who} ${day}${time ? ` kl. ${time}` : ""}`;
      default: return `Frist fra ${who}: ${day}`;
    }
  }
  switch (d.kind) {
    case "reply": return `Reply to ${who} by ${day}`;
    case "payment": return `Pay ${who} by ${day}`;
    case "complaint": return `Last day to complain to ${who}: ${day}`;
    case "appointment": return `Appointment at ${who}, ${day}${time ? ` at ${time}` : ""}`;
    default: return `Deadline from ${who}: ${day}`;
  }
}

/** When to remind: an appointment the day before at 18:00; a deadline three days before at 09:00 (never before now). */
function dueOf(d: Deadline, now: Date): string {
  const at = d.kind === "appointment"
    ? new Date(copenhagenToIso({ ...d.date, hour: 18, minute: 0 })).getTime() - 86400_000
    : new Date(copenhagenToIso({ ...d.date, hour: 9, minute: 0 })).getTime() - 3 * 86400_000;
  return new Date(Math.max(at, now.getTime())).toISOString();
}

export type LetterOpsContext = {
  sourceId: string;
  docNodeId: string | null;
  known: Pick<ImportKnown, "id" | "type" | "label" | "aliases">[];
  /** Changes already proposed from the same document (the model's reading), to reuse its node for the sender. */
  proposed?: ChangeInput[];
  visibility: "private" | "parents" | "household";
  now: Date;
  mint(): string;
  locale: "en" | "da";
};

/** The sender as an organization (matched or proposed), a link from the document, and a reminder per deadline. */
export function publicLetterOps(l: PublicLetter, ctx: LetterOpsContext): ChangeInput[] {
  const out: ChangeInput[] = [];
  const known = ctx.known.map((k) => ({ ...k, kind: null, startAt: null, props: {} }));
  const hit = matchByLabel(known, "organization", l.authority.name) ?? matchByLabel(known, "place", l.authority.name);
  const twin = (ctx.proposed ?? []).find((c) => c.op === "addNode" && (c.type === "organization" || c.type === "place") && normName(c.label) === normName(l.authority.name));
  let orgId = hit?.id ?? (twin && twin.op === "addNode" ? twin.nodeId ?? null : null);
  const receipt = { sourceId: ctx.sourceId, quote: l.authority.quote, confidence: 0.9 };
  if (!orgId) {
    orgId = ctx.mint();
    out.push({
      op: "addNode", nodeId: orgId, type: "organization", label: l.authority.name,
      summary: KIND_LABEL[l.authority.kind][ctx.locale],
      props: { authority: l.authority.kind, country: "DK" },
      visibility: ctx.visibility,
      note: `The sender of a Danish public letter (${letterTypeLabel(l.type, "en")}).`,
      receipt,
    });
  }
  if (ctx.docNodeId) {
    out.push({ op: "addEdge", edgeId: ctx.mint(), fromId: ctx.docNodeId, toId: orgId, relation: "mentions", confidence: 0.9, note: `Sent by ${l.authority.name}.`, receipt });
  }
  for (const d of l.deadlines) {
    out.push({
      op: "addReminder",
      title: reminderTitle(d, l.authority.name, ctx.locale),
      dueAt: dueOf(d, ctx.now),
      aboutNodeId: orgId,
      detail: d.quote,
      note: `A ${d.kind === "appointment" ? "time" : "deadline"} in a ${letterTypeLabel(l.type, "en")} from ${l.authority.name}.`,
      receipt: { sourceId: ctx.sourceId, quote: d.quote, ...(d.page ? { locator: { page: d.page } } : {}), confidence: 0.85 },
    });
  }
  return out;
}
