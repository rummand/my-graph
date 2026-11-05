/**
 * Rules with time limits (pure). An approved rule in the graph ("Klagefristen er 4 uger fra afgørelsen er modtaget",
 * "Lejer kan opsige med 3 måneders varsel") turns into a concrete commitment when something in the graph triggers it:
 *
 *   a decision letter (afgørelse) dated X       + a rule on appeals with a period  → notice (appeal) due X + period
 *   a consultation letter (partshøring) dated X  + a rule on comments with a period → reply due X + period
 *
 * The commitment carries BOTH receipts: the letter's sentence (the trigger) and the rule's own words (the limit).
 * When the letter states its own date for the same thing, the letter's date stands and the rule only adds its receipt.
 */
import type { PublicLetter } from "@/lib/importers/dk/public-letter";
import type { Candidate, RuleRef } from "./candidate";
import { addPeriod, anchorOf, dayKey, dueIso, numberOf, unitOf, type Day, type Unit } from "./when";

export type RuleInput = {
  id: string; nodeId: string | null; corpusName: string; ref: string; title: string; text: string; quote: string | null;
  sourceId: string | null; chunkId?: string | null; locator?: Record<string, unknown>;
};

export type TimeLimit = { n: number; unit: Unit; trigger: "decision" | "hearing"; words: string };

const PERIOD = /(?<![\p{L}])(\d{1,3}|en|et|to|tre|fire|fem|seks|otte|fjorten|one|two|three|four|six|eight|fourteen)\s+(hverdage|dage|uger|måneder|måned|år|business\s+days|days|weeks|months|years?)(?![\p{L}])/iu;

/** The time limit a rule sets, and what starts it — or null when it has none we can act on. */
export function timeLimitOf(rule: Pick<RuleInput, "title" | "text" | "quote">): TimeLimit | null {
  const text = `${rule.title}. ${rule.text} ${rule.quote ?? ""}`;
  const p = PERIOD.exec(text);
  if (!p) return null;
  const n = numberOf(p[1]);
  if (!Number.isFinite(n) || n <= 0 || n > 120) return null;
  const unit = unitOf(p[2]);
  if (/(?<![\p{L}])(klage|klagefrist|påklage|anke|indbring|genoptag|appeal|complain|review)/iu.test(text) && /(?<![\p{L}])(afgørelse|decision|ruling)/iu.test(text)) {
    return { n, unit, trigger: "decision", words: p[0] };
  }
  if (/(?<![\p{L}])(partshøring|høringsfrist|bemærkninger|kommentere|udtale\s+sig|comment|consultation|hearing)/iu.test(text)) {
    return { n, unit, trigger: "hearing", words: p[0] };
  }
  return null;
}

/** "Klagefrist" commitments for a decision letter (or reply ones for a consultation) from the graph's rules. */
export function ruleCandidates(input: { letter: PublicLetter | null; letterQuote: string | null; docDate: Date | null; now: Date; rules: RuleInput[] }): Candidate[] {
  const l = input.letter;
  if (!l || !input.letterQuote) return [];
  const trigger = l.type === "decision" ? "decision" : l.type === "hearing" ? "hearing" : null;
  if (!trigger) return [];
  const anchor: Day = anchorOf(input.docDate, input.now);
  const out: Candidate[] = [];
  for (const r of input.rules) {
    const lim = timeLimitOf(r);
    if (!lim || lim.trigger !== trigger) continue;
    const due = addPeriod(anchor, lim.n, lim.unit);
    const ref: RuleRef = { ruleId: r.id, nodeId: r.nodeId, sourceId: r.sourceId, chunkId: r.chunkId ?? null, quote: r.quote ?? r.text, locator: r.locator ?? {}, ref: r.ref, corpusName: r.corpusName };
    out.push({
      detector: "rule", kind: trigger === "decision" ? "notice" : "reply", flavor: trigger === "decision" ? "complaint" : "hearing", direction: "owe",
      dueAt: dueIso(due), dueDay: dayKey(due), dueKind: "deadline", dueWords: `${lim.words} (${r.corpusName} ${r.ref})`,
      counterparty: { name: l.authority.name, type: "organization" }, owner: { by: "viewer" },
      quote: input.letterQuote, confidence: input.docDate ? 0.75 : 0.6, rule: ref,
    });
    // One rule per trigger is enough; the best one comes first (the caller sorts by relevance).
    break;
  }
  return out;
}
