/**
 * Contradictions (pure): the same obligation stated differently by two sources — the lease says three months' notice,
 * the landlord's email says one; a newer letter moves the due date; two amounts disagree; the approved rule gives four
 * weeks to complain, the letter two. Each one is an advisory flag with both quotes. When one source clearly outranks
 * the other (official letter > letter > email > chat; on a tie the newer wins) and the commitment holds the weaker
 * value, a fix is suggested — the caller turns that into a proposal; nothing is changed here.
 *
 * Rules (approved corpus rules) are stated rights and duties, not facts about this one case: they flag, never fix.
 */
import type { CommitmentKind } from "../types";
import { dayIn, findAmounts, findDueDates, findPeriods, sameAmount, samePeriod, type PeriodTopic } from "./text";

/** How much a source counts when two disagree. */
export type SourceClass = "rule" | "official" | "letter" | "email" | "chat" | "note";

export const SOURCE_RANK: Record<SourceClass, number> = { rule: 5, official: 4, letter: 3, email: 2, chat: 1, note: 0 };

/** Classify a library source from what the pipeline recorded about it (no model). */
export function classifySource(s: { kind?: string | null; mime?: string | null; title?: string | null; meta?: Record<string, unknown> | null }): SourceClass {
  const meta = s.meta ?? {};
  const importer = typeof meta.importer === "string" ? meta.importer : "";
  if (meta.danish || /digital ?post|e-boks|mitid|skat\.dk|borger\.dk|kommune|styrelse|ministeri/i.test(`${s.title ?? ""} ${importer}`)) return "official";
  if (/whatsapp|messenger|imessage|instagram|sms|aula|holdsport|spond/i.test(importer) || meta.docKind === "chat") return "chat";
  if (s.kind === "email" || meta.docKind === "mail" || meta.email) return "email";
  if (/lejekontrakt|lease|kontrakt|contract|police|policy|aftale|agreement|vilkår|terms/i.test(s.title ?? "")) return "official";
  if (meta.docKind === "letter" || meta.docKind === "scan" || /pdf|wordprocessingml/.test(s.mime ?? "")) return "letter";
  if (s.kind === "chat") return "chat";
  return "note";
}

export type Statement = {
  sourceId: string;
  title: string;
  cls: SourceClass;
  /** When the source itself is dated (letter date, email sent), else when it was added. */
  date: Date | null;
  text: string;
  /**
   * How it is tied to the commitment: its own source, the same conversation, or only the same other party (a landlord's
   * email about the lease). Due dates and amounts are compared only between own and same-thread sources — the same
   * teacher writing about a different trip is not a contradiction — periods (notice, complaint) also with "party".
   */
  rel?: "own" | "thread" | "party";
  /** A rule: its id and reference ("§ 16, stk. 2"), for the flag. */
  ruleId?: string;
  ruleRef?: string | null;
};

export type FieldValue =
  | { field: "dueAt"; day: string }
  | { field: "amount"; value: number; currency: string }
  | { field: "period"; days: number; topic: PeriodTopic };

export type Claim = { sourceId: string; title: string; cls: SourceClass; date: Date | null; quote: string; value: FieldValue; ruleId?: string; ruleRef?: string | null; moved?: boolean };

export type Contradiction = {
  /** Stable: field + the two sources. */
  key: string;
  field: FieldValue["field"];
  a: Claim;
  b: Claim;
  /** The claim that wins (stronger source, or newer on a tie); null when neither clearly does (or a rule is involved). */
  winner: Claim | null;
  /** Set when the commitment holds the losing value and the winner can be written to it. */
  fix: { set: Record<string, unknown>; from: Claim } | null;
};

export type ContradictionCommitment = {
  id: string;
  kind: CommitmentKind;
  dueAt: string | null;
  amount?: { value: number; currency: string } | null;
};

const PAY_WORDS = /(at betale|til betaling|beløb|i alt|total|amount|to pay|husleje|rent|faktura|invoice|regning|gebyr|fee|pris|price|depositum|deposit|skyldig)/i;

/** What kind of periods matter for which commitments. */
const PERIOD_TOPICS: Partial<Record<CommitmentKind, PeriodTopic[]>> = {
  notice: ["notice", "complaint"], reply: ["reply", "complaint"], renewal: ["notice"], form: ["reply"],
};

/** Claims one statement makes that bear on this commitment. */
export function claimsOf(c: ContradictionCommitment, s: Statement): Claim[] {
  const base = { sourceId: s.sourceId, title: s.title, cls: s.cls, date: s.date, ruleId: s.ruleId, ruleRef: s.ruleRef };
  const out: Claim[] = [];
  const topics = PERIOD_TOPICS[c.kind] ?? [];
  if (topics.length) {
    for (const p of findPeriods(s.text)) if (topics.includes(p.topic)) out.push({ ...base, quote: p.quote, value: { field: "period", days: p.days, topic: p.topic } });
  }
  const close = s.rel !== "party";
  if (s.cls !== "rule" && close && c.dueAt) {
    const ref = s.date ?? new Date(c.dueAt);
    for (const d of findDueDates(s.text, ref)) out.push({ ...base, quote: d.quote, moved: d.moved, value: { field: "dueAt", day: d.day } });
  }
  if (s.cls !== "rule" && close && c.kind === "payment" && c.amount) {
    for (const a of findAmounts(s.text)) {
      const around = s.text.slice(Math.max(0, a.index - 60), a.index + a.quote.length + 20);
      if (!PAY_WORDS.test(around)) continue;
      out.push({ ...base, quote: around.replace(/\s+/g, " ").trim(), value: { field: "amount", value: a.value, currency: a.currency } });
    }
  }
  return out;
}

function sameValue(x: FieldValue, y: FieldValue): boolean {
  if (x.field === "dueAt" && y.field === "dueAt") return x.day === y.day;
  if (x.field === "amount" && y.field === "amount") return sameAmount(x, y);
  if (x.field === "period" && y.field === "period") return x.topic === y.topic && samePeriod(x.days, y.days);
  return true;
}

function comparable(x: FieldValue, y: FieldValue): boolean {
  return x.field === y.field && (x.field !== "period" || (y.field === "period" && x.topic === y.topic));
}

/** Which of two claims wins: the stronger source, else the newer one; null when neither does or a rule is involved. */
export function strongerOf(a: Claim, b: Claim): Claim | null {
  if (a.cls === "rule" || b.cls === "rule") return null;
  const ra = SOURCE_RANK[a.cls], rb = SOURCE_RANK[b.cls];
  if (ra !== rb) return ra > rb ? a : b;
  const ta = a.date?.getTime() ?? 0, tb = b.date?.getTime() ?? 0;
  if (ta === tb) return null;
  return ta > tb ? a : b;
}

/**
 * The single claim a source makes for a field, or null when it makes several different ones (a letter listing three
 * deadlines doesn't contradict anything by itself: we can't tell which one is ours). A due date marked as moved
 * ("ny frist", "postponed to") is taken even among others.
 */
function onlyClaim(claims: Claim[], fieldKey: string): Claim | null {
  const mine = claims.filter((c) => keyOf(c.value) === fieldKey);
  if (!mine.length) return null;
  const moved = mine.filter((c) => c.moved);
  const pool = moved.length ? moved : mine;
  const first = pool[0];
  return pool.every((c) => sameValue(c.value, first.value)) ? first : null;
}

const keyOf = (v: FieldValue) => (v.field === "period" ? `period:${v.topic}` : v.field);

/** Does the commitment currently hold this value? */
function holds(c: ContradictionCommitment, v: FieldValue, tz: string): boolean | null {
  if (v.field === "dueAt") return c.dueAt ? dayIn(new Date(c.dueAt), tz) === v.day : null;
  if (v.field === "amount") return c.amount ? sameAmount(c.amount, v) : null;
  return null;
}

/**
 * Pair up what the sources say about one commitment. Due dates: only a source that names one due date (or marks one as
 * moved) counts, and only when one of the two matches what the commitment holds — so an unrelated deadline in the
 * same letter is not a contradiction.
 */
export function findContradictions(c: ContradictionCommitment, statements: Statement[], tz = "Europe/Copenhagen"): Contradiction[] {
  const perSource = new Map<string, Claim[]>();
  for (const s of statements) perSource.set(s.sourceId + (s.ruleId ? `:${s.ruleId}` : ""), claimsOf(c, s));
  const fieldKeys = new Set([...perSource.values()].flat().map((x) => keyOf(x.value)));
  const out: Contradiction[] = [];
  for (const fk of fieldKeys) {
    const picks = [...perSource.values()].map((cl) => onlyClaim(cl, fk)).filter((x): x is Claim => !!x);
    for (let i = 0; i < picks.length; i++) {
      for (let j = i + 1; j < picks.length; j++) {
        const a = picks[i], b = picks[j];
        if (a.sourceId === b.sourceId && a.ruleId === b.ruleId) continue;
        if (!comparable(a.value, b.value) || sameValue(a.value, b.value)) continue;
        if (a.cls === "rule" && b.cls === "rule") continue;
        if (a.value.field === "dueAt" && !holds(c, a.value, tz) && !holds(c, b.value, tz)) continue;
        // Older first, so "a" reads as what was said before and "b" as what was said after.
        const [x, y] = (a.date?.getTime() ?? 0) <= (b.date?.getTime() ?? 0) ? [a, b] : [b, a];
        const winner = strongerOf(x, y);
        const loser = winner ? (winner === x ? y : x) : null;
        let fix: Contradiction["fix"] = null;
        if (winner && loser && holds(c, loser.value, tz) === true && holds(c, winner.value, tz) === false) {
          if (winner.value.field === "dueAt") {
            const due = movedTo(c.dueAt!, winner.value.day, tz);
            fix = { set: { startAt: due, props: { dueAt: due } }, from: winner };
          }
          else if (winner.value.field === "amount") fix = { set: { props: { amount: { value: winner.value.value, currency: winner.value.currency } } }, from: winner };
        }
        const ids = [x.ruleId ?? x.sourceId, y.ruleId ?? y.sourceId].sort();
        out.push({ key: `${fk}:${ids.join("|")}`, field: x.value.field, a: x, b: y, winner, fix });
      }
    }
  }
  return dedupe(out);
}

function dedupe(list: Contradiction[]): Contradiction[] {
  const seen = new Set<string>();
  return list.filter((c) => (seen.has(c.key) ? false : (seen.add(c.key), true)));
}

/** The due time moved to another local day, keeping its time of day ("23:59" deadlines stay so). */
export function movedTo(iso: string, day: string, tz: string): string {
  const cur = new Date(iso);
  const from = Date.parse(`${dayIn(cur, tz)}T00:00:00Z`), to = Date.parse(`${day}T00:00:00Z`);
  return new Date(cur.getTime() + (to - from)).toISOString();
}

/* ── Plain words ─────────────────────────────────────────────────────────────────────────────────────── */

function valueText(v: FieldValue, locale: "en" | "da"): string {
  if (v.field === "amount") return `${new Intl.NumberFormat(locale === "da" ? "da-DK" : "en-GB", { minimumFractionDigits: v.value % 1 ? 2 : 0, maximumFractionDigits: 2 }).format(v.value)} ${v.currency === "DKK" ? "kr" : v.currency}`;
  if (v.field === "dueAt") return new Intl.DateTimeFormat(locale === "da" ? "da-DK" : "en-GB", { day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${v.day}T12:00:00Z`));
  const d = v.days;
  const [n, u] = d % 365 === 0 ? [d / 365, locale === "da" ? ["år", "år"] : ["year", "years"]]
    : d % 30 === 0 ? [d / 30, locale === "da" ? ["måned", "måneder"] : ["month", "months"]]
      : d % 7 === 0 ? [d / 7, locale === "da" ? ["uge", "uger"] : ["week", "weeks"]]
        : [d, locale === "da" ? ["dag", "dage"] : ["day", "days"]];
  return `${n} ${n === 1 ? u[0] : u[1]}`;
}

function sourceName(c: Claim, locale: "en" | "da"): string {
  if (c.cls === "rule") return locale === "da" ? `reglen${c.ruleRef ? ` (${c.ruleRef})` : ""}` : `the rule${c.ruleRef ? ` (${c.ruleRef})` : ""}`;
  return locale === "da" ? `„${c.title}“` : `“${c.title}”`;
}

/** "The rule (§ 16) says 4 weeks, “Afgørelse.pdf” says 2 weeks." in the reader's language. */
export function explainContradiction(x: Contradiction, locale: "en" | "da"): string {
  const say = locale === "da" ? "siger" : "says";
  const first = `${sourceName(x.a, locale)} ${say} ${valueText(x.a.value, locale)}`;
  const second = `${sourceName(x.b, locale)} ${say} ${valueText(x.b.value, locale)}`;
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const tail = x.winner
    ? locale === "da" ? ` ${cap(sourceName(x.winner, locale))} vejer tungest.` : ` ${cap(sourceName(x.winner, locale))} carries more weight.`
    : locale === "da" ? " Tjek hvilken der gælder." : " Check which one applies.";
  return `${cap(first)}, ${second}.${tail}`;
}
