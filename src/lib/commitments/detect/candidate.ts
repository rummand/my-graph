/**
 * What a detector found (pure): one commitment, not yet tied to the graph. The ops builder (./ops.ts) matches its
 * parties against the graph, checks it isn't known already, words its label and turns it into proposals.
 */
import type { CommitmentDirection, CommitmentKind, DueKind } from "../types";

export type Locale = "en" | "da";

/** The other party, as the text names it. */
export type Party = { name: string; type: "organization" | "person"; email?: string | null };

/**
 * Who has to act, as far as the text can tell:
 *   viewer   the person the letter, email or request is addressed to (the reader / uploader)
 *   person   someone named (a chat's sender who promised something, an email's sender)
 *   about    a parent of the child it concerns (school), else the reader
 */
export type OwnerHint = { by: "viewer" } | { by: "person"; name?: string | null; email?: string | null } | { by: "about" };

export type Detector = "letter" | "invoice" | "contract" | "school" | "message" | "calendar" | "rule" | "model";

/** An approved rule with a time limit that this commitment also rests on (its second receipt). */
export type RuleRef = {
  ruleId: string; nodeId: string | null; sourceId: string | null; chunkId?: string | null; quote: string | null;
  locator?: Record<string, unknown>; ref: string; corpusName: string;
};

/** Sub-flavours that change only the wording. */
export type Flavor = "complaint" | "cancel" | "invitation" | "hearing" | null;

export type Candidate = {
  detector: Detector;
  kind: CommitmentKind;
  direction: CommitmentDirection;
  flavor?: Flavor;
  /** ISO instant (see when.ts dueIso), or null when no day is known ("soon"). */
  dueAt: string | null;
  /** Copenhagen calendar day of dueAt ("2026-12-15"), for fingerprints. */
  dueDay: string | null;
  dueKind: "deadline" | "date" | "approx" | "recurring" | DueKind;
  /** The wording of a vague or relative time ("next week", "inden 14 dage fra modtagelsen"). */
  dueWords?: string | null;
  recurrence?: string | null;
  leadDays?: number | null;
  amount?: { value: number; currency: string } | null;
  consequence?: string | null;
  counterparty: Party | null;
  /** What it concerns, in the source's words ("skolebuskort", "bilforsikring", "the trailer"). */
  subject?: string | null;
  /** A node it is about, by name (a child named in a school message), resolved against the graph later. */
  aboutName?: string | null;
  /** What has to be done, in the source's words, for deliver/return/other ("madpakke og regntøj"). */
  action?: string | null;
  owner: OwnerHint;
  /** Verbatim from the source text (verified before it is proposed). */
  quote: string;
  page?: number;
  region?: string;
  confidence: number;
  rule?: RuleRef | null;
  /** A model's label in each language, when the model found it (detectors leave it to labels.ts). */
  label?: { en?: string | null; da?: string | null } | null;
};

/** The text a detector reads: segments as the pipeline stored them (pages for PDFs, regions for chats). */
export type Segment = { text: string; page?: number; region?: string };

export type SourceKind = "document" | "email" | "chat" | "message";

export type EmailInfo = {
  from?: { name: string | null; email: string } | null;
  to?: { name: string | null; email: string }[];
  subject?: string | null;
};

export type DetectInput = {
  title: string;
  segments: Segment[];
  sourceKind: SourceKind;
  /** When the source itself is dated (letter date, email sent); relative wording counts from here. */
  docDate: Date | null;
  now: Date;
  locale: Locale;
  email?: EmailInfo | null;
  /** The reader's own names and email (to tell "me" in a chat, and an email addressed to them). */
  self?: { names: string[]; emails: string[] } | null;
};

/** Whitespace-insensitive comparison, the way quotes are checked against the text. */
export const squash = (s: string) => s.normalize("NFC").replace(/[ \s]+/g, " ").trim();

/** A sentence (or line) around a position, verbatim but with runs of whitespace kept as they are in the text. */
export function sentenceAt(text: string, index: number, len: number, max = 280): string {
  let start = index;
  // Back to the sentence's start: a line break, or ". " / "! " / "? " (not "2.B" or "kl.10").
  while (start > 0 && index - start < 180 && text[start - 1] !== "\n" && !(/[.!?]/.test(text[start - 1]) && /\s/.test(text[start] ?? ""))) start--;
  // Don't stop at "kl." "nr." "d." and abbreviations followed by a digit or lower-case letter.
  let end = index + len;
  while (end < text.length && end - index < 240) {
    const ch = text[end];
    if (ch === "\n") break;
    if (/[.!?]/.test(ch) && (end + 1 >= text.length || /\s/.test(text[end + 1])) && !/(?:kl|nr|ca|jf|bl\.a|f\.eks|evt|inkl|vedr|dvs|mr|mrs|dr|st|ref|d)$/i.test(text.slice(Math.max(0, end - 6), end)) && !/^\s+[\p{Ll}\d]/u.test(text.slice(end + 1, end + 3))) { end++; break; }
    end++;
  }
  return text.slice(start, Math.min(text.length, end)).trim().slice(0, max);
}

/** True when the quote is in the text (whitespace-insensitive, otherwise exact). */
export function quoteIn(quote: string, text: string): boolean {
  const q = squash(quote);
  return q.length >= 6 && squash(text).includes(q);
}
