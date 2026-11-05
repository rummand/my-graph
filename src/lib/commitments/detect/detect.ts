/**
 * Detection, all detectors together (pure): what a source owes, is owed or promised, as candidates with verified
 * quotes, de-duplicated within the source. The model's candidates (./model.ts) and the graph's rules (./rules.ts)
 * are passed in by the server layer; everything here runs without a model or a database.
 */
import { classifyPublicLetter, type PublicLetter } from "@/lib/importers/dk/public-letter";
import { quoteIn, sentenceAt, squash, type Candidate, type DetectInput } from "./candidate";
import { contractCandidates } from "./contracts";
import { invoiceCandidates } from "./invoice";
import { letterCandidates } from "./letters";
import { invitationCandidates, messageCandidates } from "./messages";
import { ruleCandidates, type RuleInput } from "./rules";
import { schoolCandidates } from "./school";
import { normParty } from "./fingerprint";
import { addDays, copenhagenDay, dayKey } from "./when";

export type DetectOptions = {
  /** The public letter the pipeline already recognised (else it is read here for documents). */
  letter?: PublicLetter | null;
  /** Approved rules of the graph with their text (only those with a time limit matter). */
  rules?: RuleInput[];
  /** What the model found (already verified against the text). */
  model?: Candidate[];
};

export type Detected = { candidates: Candidate[]; letter: PublicLetter | null; dropped: number };

/** The sentence that shows a letter is a decision (or a consultation), for a rule-based commitment's receipt. */
function triggerQuote(text: string, letter: PublicLetter): string | null {
  const re = letter.type === "decision" ? /(?<![\p{L}])(afgørelse|har\s+besluttet|har\s+truffet)/iu : /(?<![\p{L}])(partshøring|høring|bemærkninger)/iu;
  const m = re.exec(text);
  return m ? sentenceAt(text, m.index, m[0].length) : null;
}

export function detectCommitments(input: DetectInput, opts: DetectOptions = {}): Detected {
  const text = input.segments.map((s) => s.text).join("\n\n");
  if (!text.trim()) return { candidates: [], letter: null, dropped: 0 };
  const letter = opts.letter !== undefined ? opts.letter
    : input.sourceKind === "document" || input.sourceKind === "message" ? classifyPublicLetter(input.segments.map((s) => ({ text: s.text, page: s.page })), input.now) : null;
  const all: Candidate[] = [
    ...letterCandidates(input, letter),
    ...invoiceCandidates(input),
    ...contractCandidates(input),
    ...schoolCandidates(input),
    ...invitationCandidates(input),
    ...messageCandidates(input),
  ];
  // Rules with time limits: a second receipt on the letter's own deadline, or a deadline the letter left out.
  if (letter && opts.rules?.length) {
    for (const r of ruleCandidates({ letter, letterQuote: triggerQuote(text, letter), docDate: input.docDate, now: input.now, rules: opts.rules })) {
      const same = all.find((c) => c.kind === r.kind && c.detector === "letter" && (c.flavor === r.flavor || r.kind === "notice"));
      if (same) same.rule = r.rule;
      else all.push(r);
    }
  }
  all.push(...(opts.model ?? []));

  const today = copenhagenDay(input.now);
  const stale = dayKey(addDays(today, -14));
  const out: Candidate[] = [];
  let dropped = 0;
  for (const c of all) {
    // The receipt must hold: the quote is in the source, verbatim (whitespace aside).
    if (!quoteIn(c.quote, text)) { dropped++; continue; }
    if (c.dueDay && c.dueDay < stale && !c.recurrence) { dropped++; continue; }
    const q = squash(c.quote).toLowerCase();
    const twin = out.find((o) => (squash(o.quote).toLowerCase() === q && o.kind === c.kind)
      || (o.kind === c.kind && o.dueDay === c.dueDay && !!c.dueDay && normParty(o.counterparty?.name) === normParty(c.counterparty?.name)));
    if (twin) {
      // Same commitment from two detectors: keep the first (more specific) and fill in what it lacks.
      twin.amount ??= c.amount ?? null;
      twin.consequence ??= c.consequence ?? null;
      twin.rule ??= c.rule ?? null;
      twin.subject ??= c.subject ?? null;
      dropped++;
      continue;
    }
    // The model saying the same as a rule-based detector in other words (same kind and day): the detector wins.
    if (c.detector === "model" && out.some((o) => o.kind === c.kind && o.dueDay === c.dueDay && o.detector !== "model")) { dropped++; continue; }
    out.push(c);
  }
  return { candidates: out.slice(0, 25), letter, dropped: dropped + Math.max(0, out.length - 25) };
}
