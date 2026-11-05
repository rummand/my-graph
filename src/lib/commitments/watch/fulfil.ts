/**
 * Fulfilment (pure): does a new source show that an open commitment is done? "Closes the loop" without a model:
 *
 *   payment      a receipt / confirmation ("Kvittering", "Tak for din betaling", "Payment received") naming the
 *                payee, with the amount when the commitment has one, in the date window
 *   reply/form   a confirmation of receipt ("Tak for din ansøgning", "We have received your …"), or a message the
 *                person sent to the other party (or in the same thread) after the request arrived
 *   deliver/return  "afleveret", "returneret", "sendt", "handed in", "returned it" with the other party named
 *   notice/renewal  a confirmation of the notice / renewal, or the notice itself sent to the other party
 *   appointment  an event with the other party that has happened, on the day it was due (see `matchHappenedEvent`)
 *
 * Reminders ("Rykker", "not yet received") and requests ("skal være betalt senest", "please pay") never count. A match
 * is a proposal (status done, with the evidence and its quote); a missed deadline is never proposed — the ledger shows
 * it as overdue.
 */
import type { CommitmentDirection, CommitmentKind } from "../types";
import { findAmounts, hasName, nameVariants, norm, quoteAround, sameAmount } from "./text";

export type FulfilCommitment = {
  id: string;
  label: string;
  kind: CommitmentKind;
  direction: CommitmentDirection;
  dueAt: Date | null;
  /** When it appeared (the node was made, or the letter it arises from is dated). */
  appearedAt: Date;
  amount?: { value: number; currency: string } | null;
  counterparty: { names: string[]; emails: string[] };
  /** Threads the commitment came from (email / Aula threads of its arises_from sources). */
  threadKeys: string[];
  /** Its own sources: they are never evidence that it's done. */
  ownSourceIds: string[];
  /** Recurring ones move on instead of closing; the window is around the current due date. */
  recurring?: boolean;
};

export type Evidence = {
  sourceId: string;
  title: string;
  text: string;
  date: Date | null;
  /** The person (the commitment's owner, or whoever is responsible) wrote/sent it. */
  authoredByOwner: boolean;
  /** Email addresses it was sent to / from (lower case). */
  participants: { email: string; name?: string | null; role?: string | null }[];
  threadKey: string | null;
};

export type FulfilMatch = {
  commitmentId: string;
  sourceId: string;
  confidence: number;
  quote: string;
  doneAt: string;
  reasons: ("phrase" | "amount" | "counterparty" | "thread" | "sent" | "event")[];
};

const DAY = 86_400_000;

/** Phrases that say it is done, per kind (Danish and English; matched on normalised text). */
const DONE: Record<string, RegExp> = {
  payment: /(betalingskvittering|kvittering|tak for (din |jeres )?betaling|betaling(en)? (er )?(modtaget|gennemført|godkendt|registreret|bekræftet)|vi har modtaget (din |jeres )?betaling|er betalt|betalt via|betalt med|betalt den|overførsel(en)? (er )?gennemført|overført til|receipt|payment (received|confirmed|successful|complete|completed)|thank you for your payment|paid (on|by|with|via)|has been paid|transfer (completed|sent)|refund(ed)?|tilbagebetal\w*|udbetalt)/,
  confirm: /(tak for (din |jeres )?(ansøgning|henvendelse|tilmelding|besvarelse|indsendelse|svar|opsigelse|bestilling)|vi har modtaget (din|dit|jeres|en)|kvittering for (modtagelse|indsendelse|din)|er (nu )?(indsendt|registreret|modtaget)|tilmelding(en)? er (modtaget|registreret|bekræftet)|thank you for (your )?(application|submission|response|reply|registration|order)|we have received your|has been (submitted|received|registered)|successfully submitted|registration confirmed)/,
  deliver: /(afleveret|indleveret|har sendt|er sendt|sendt (til|i dag|afsted)|handed in|have sent|has been sent|i sent|delivered|dropped off)/,
  return: /(afleveret tilbage|leveret tilbage|givet tilbage|returneret|har returneret|returned (it|the)|gave it back|brought it back|depositum(met)? (er )?(udbetalt|tilbagebetalt|overført)|deposit (has been )?(returned|refunded))/,
  notice: /(bekræftelse på (din |jeres )?opsigelse|opsigelse(n)? (er )?(modtaget|bekræftet|registreret)|vi bekræfter (din |jeres )?opsigelse|er (hermed )?opsagt|we confirm (your |the )?(cancellation|termination|notice)|(cancellation|termination|notice) (is |has been )?(confirmed|received)|opsiger hermed|i hereby (give notice|cancel|terminate))/,
  renewal: /(er (nu )?fornyet|fornyelse(n)? (er )?(bekræftet|gennemført)|forlænget til|has been renewed|renewal (is )?confirmed|renewed until|extended until|ny police)/,
};
/** A sent message that is itself the notice. */
const SENT_NOTICE = /(opsiger hermed|jeg opsiger|vi opsiger|i hereby (give notice|cancel|terminate)|we hereby (give notice|cancel|terminate)|please (accept|consider) this (as )?(my|our) notice|klager hermed|vil gerne klage|i wish to (complain|appeal))/;

/** Never evidence of done: reminders, demands, "not yet". */
const VETO = /(rykker|påmindelse|betalingspåmindelse|inkasso|ikke (modtaget|betalt|registreret)|endnu ikke|mangler (din|at|stadig)|udestående|forfalden|reminder|not (yet )?(received|paid)|unpaid|outstanding|overdue|past due|final notice|has not been)/;
/** Words of a request or an invoice. */
const REQUEST = /(skal (v\u00e6re )?betal|bedes (betalt|indbetalt|overf\u00f8rt)|betales senest|betalingsfrist|at betale senest|must be paid|to be paid|please pay|payment due|amount due|due date)/;
/** A done-word inside a request ("skal være betalt senest", "must be paid by") is not a done-word. */
const REQUEST_BEFORE = /(skal (være )?|bedes |bør (være )?|vil blive |must be |to be |will be |should be |please (be )?|kan )$/;

const PHRASES_FOR: Record<CommitmentKind, (keyof typeof DONE)[]> = {
  payment: ["payment"], reply: ["confirm"], form: ["confirm"], deliver: ["deliver", "confirm"], return: ["return"],
  notice: ["notice"], renewal: ["renewal", "payment"], appointment: [], other: ["confirm", "deliver"],
};

/** The first done-phrase in the text that isn't part of a request; its index and length. */
export function donePhrase(text: string, kind: CommitmentKind): { index: number; length: number } | null {
  const t = norm(text);
  for (const k of PHRASES_FOR[kind]) {
    const re = new RegExp(DONE[k].source, "g");
    for (const m of t.matchAll(re)) {
      const i = m.index ?? 0;
      if (REQUEST_BEFORE.test(t.slice(Math.max(0, i - 24), i))) continue;
      return { index: i, length: m[0].length };
    }
  }
  return null;
}

export function vetoed(text: string): boolean {
  return VETO.test(norm(text));
}

function domainOf(email: string): string | null {
  const d = email.split("@")[1]?.toLowerCase();
  if (!d || /^(gmail|hotmail|outlook|live|yahoo|icloud|me|mail|protonmail|msn)\./.test(d)) return null;
  return d;
}

/** Does the evidence name or address the other party? */
export function mentionsCounterparty(c: Pick<FulfilCommitment, "counterparty">, ev: Pick<Evidence, "text" | "title" | "participants">): boolean {
  const t = norm(`${ev.title}\n${ev.text}`);
  if (c.counterparty.names.flatMap(nameVariants).some((n) => hasName(t, n))) return true;
  const emails = new Set(c.counterparty.emails.map((e) => e.toLowerCase()));
  const domains = new Set(c.counterparty.emails.map(domainOf).filter((d): d is string => !!d));
  return ev.participants.some((p) => emails.has(p.email.toLowerCase()) || (domainOf(p.email) !== null && domains.has(domainOf(p.email)!)))
    || [...emails].some((e) => t.includes(e));
}

/** Was it sent to the other party (not just from them)? */
function sentToCounterparty(c: Pick<FulfilCommitment, "counterparty">, ev: Evidence): boolean {
  const emails = new Set(c.counterparty.emails.map((e) => e.toLowerCase()));
  const domains = new Set(c.counterparty.emails.map(domainOf).filter((d): d is string => !!d));
  const to = ev.participants.filter((p) => p.role === "to" || p.role === "cc");
  if (to.some((p) => emails.has(p.email.toLowerCase()) || (domainOf(p.email) !== null && domains.has(domainOf(p.email)!)))) return true;
  return to.some((p) => p.name && c.counterparty.names.flatMap(nameVariants).some((n) => hasName(norm(p.name!), n)));
}

/** The window in which evidence can count: from two weeks before it appeared until 45 days after it was due. */
export function inWindow(c: Pick<FulfilCommitment, "appearedAt" | "dueAt" | "recurring">, at: Date): boolean {
  const t = at.getTime();
  const from = c.recurring && c.dueAt ? c.dueAt.getTime() - 45 * DAY : c.appearedAt.getTime() - 14 * DAY;
  const to = c.dueAt ? c.dueAt.getTime() + 45 * DAY : Number.POSITIVE_INFINITY;
  return t >= from && t <= to;
}

/** Does this source show the commitment is done? Precision over recall: a miss waits for the person; a wrong "done" hides a duty. */
export function matchFulfilment(c: FulfilCommitment, ev: Evidence): FulfilMatch | null {
  if (c.ownSourceIds.includes(ev.sourceId)) return null;
  if (c.kind === "appointment") return null; // appointments close by an event that happened, not a document
  const at = ev.date ?? null;
  if (!at || !inWindow(c, at)) return null;
  const text = `${ev.title}\n${ev.text}`;
  if (vetoed(text)) return null;
  // An invoice or a request ("skal være betalt senest", "please pay") is not a receipt, unless its own words say done.
  if (REQUEST.test(norm(ev.text)) && !donePhrase(ev.text, c.kind)) return null;

  const reasons: FulfilMatch["reasons"] = [];
  const counterparty = mentionsCounterparty(c, ev);
  const thread = !!ev.threadKey && c.threadKeys.includes(ev.threadKey);
  if (counterparty) reasons.push("counterparty");
  if (thread) reasons.push("thread");

  // Amounts: when the commitment has one and the source names amounts, one must match.
  let amountHit: { index: number; quote: string } | null = null;
  const amounts = findAmounts(text);
  if (c.amount && amounts.length) {
    const hit = amounts.find((a) => sameAmount(a, c.amount!));
    if (!hit) return null;
    amountHit = { index: hit.index, quote: hit.quote };
    reasons.push("amount");
  }

  const phrase = donePhrase(text, c.kind);
  const normText = norm(text);
  // What the person sent: a reply to the other party, or in the same thread, after it appeared.
  const sent = ev.authoredByOwner && at.getTime() >= c.appearedAt.getTime() && (thread || sentToCounterparty(c, ev));
  const sentCounts = sent && (c.kind === "reply" || c.kind === "form" || c.kind === "deliver" || ((c.kind === "notice" || c.kind === "other") && SENT_NOTICE.test(normText)));

  let ok = false;
  if (c.kind === "payment") {
    // A receipt naming the payee (or in the thread) — with the amount when there is one, or the payee spelled out when there isn't.
    ok = !!phrase && (counterparty || thread) && (!c.amount || !!amountHit || (!amounts.length && counterparty && thread));
  } else if (sentCounts) {
    ok = true;
    reasons.push("sent");
  } else {
    ok = !!phrase && (counterparty || thread);
  }
  if (!ok) return null;
  if (phrase) reasons.unshift("phrase");

  const quote = evidenceQuote(ev, c.kind, amountHit?.quote ?? null);

  const confidence = Math.min(0.95, 0.55 + (counterparty ? 0.15 : 0) + (amountHit ? 0.15 : 0) + (thread ? 0.1 : 0) + (reasons.includes("sent") ? 0.1 : 0));
  return { commitmentId: c.id, sourceId: ev.sourceId, confidence: Math.round(confidence * 100) / 100, quote, doneAt: at.toISOString(), reasons };
}

/**
 * The words the proof rests on, taken from the source's own text (so the passage can be found and highlighted):
 * the done-phrase and the amount together when they are close, else the phrase, else the amount, else the opening.
 */
function evidenceQuote(ev: Evidence, kind: CommitmentKind, amount: string | null): string {
  const body = ev.text.trim() ? ev.text : ev.title;
  const lower = body.toLowerCase();
  const p = donePhrase(body, kind);
  let at: [number, number] | null = null;
  if (p) {
    const words = norm(body).slice(p.index, p.index + p.length);
    const i = lower.indexOf(words);
    if (i >= 0) at = [i, i + words.length];
  }
  const a = amount ? body.indexOf(amount) : -1;
  if (at && a >= 0) {
    const s = Math.min(at[0], a), e = Math.max(at[1], a + amount!.length);
    if (e - s <= 220) return quoteAround(body, s, e, Math.max(180, e - s + 20));
    return `${quoteAround(body, at[0], at[1], 120)} … ${quoteAround(body, a, a + amount!.length, 60)}`;
  }
  if (at) return quoteAround(body, at[0], at[1], 180);
  if (a >= 0) return quoteAround(body, a, a + amount!.length, 180);
  return quoteAround(body, 0, Math.min(body.length, 60), 180);
}

/** An event that happened shows an appointment is done: same day as it was due, with the other party or the same words. */
export function matchHappenedEvent(
  c: Pick<FulfilCommitment, "id" | "kind" | "label" | "dueAt" | "counterparty">,
  ev: { id: string; label: string; start: Date; end: Date | null; involves: string[]; involvesNames: string[] },
  now: Date,
): { confidence: number; doneAt: string } | null {
  if (c.kind !== "appointment" || !c.dueAt) return null;
  const end = ev.end ?? new Date(ev.start.getTime() + 60 * 60_000);
  if (end.getTime() > now.getTime()) return null;
  if (Math.abs(ev.start.getTime() - c.dueAt.getTime()) > 12 * 60 * 60_000) return null;
  const withParty = ev.involvesNames.some((n) => c.counterparty.names.some((m) => norm(m) === norm(n)))
    || c.counterparty.names.flatMap(nameVariants).some((n) => hasName(norm(ev.label), n));
  const words = (s: string) => new Set(norm(s).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3));
  const a = words(c.label), b = words(ev.label);
  const shared = [...b].filter((w) => a.has(w)).length;
  if (!withParty && shared < 1) return null;
  return { confidence: withParty ? 0.8 : 0.65, doneAt: end.toISOString() };
}
