/**
 * Emails and chats (pure): requests and promises with a time.
 *
 *   request  "Kan du sende kontrakten inden fredag?", "Husk at betale for lejren", "Could you send it by Monday?",
 *            "Deadline Monday", "Please return the form by 3 March"   → owe: the reader acts, for the sender
 *   promise  "Jeg afleverer traileren i næste uge", "I'll return the trailer next week", "Det skal jeg nok sende i
 *            morgen"                                                   → promise: whoever wrote it acts
 *
 * Chats are read line by line ("12:04 Lars: …" under a "WhatsApp · Lars · 2026-11-02" heading); the day of the line
 * anchors "i morgen" and "fredag". Only recent lines count (old chat history holds old promises), and only with a
 * time (a date, a weekday, "next week", "i morgen", or "asap" for a request). Quoted replies in emails are skipped.
 */
import { sentenceAt, type Candidate, type DetectInput, type OwnerHint, type Party } from "./candidate";
import { SOON, allWhens, anchorOf, compareDays, copenhagenDay, addDays, dayKey, dueIso, type Day } from "./when";
import type { CommitmentKind } from "../types";

/** How far back a chat line may be and still hold an open commitment. */
export const CHAT_LOOKBACK_DAYS = 45;

const REQUEST = /(?<![\p{L}])(kan\s+du|kunne\s+du|vil\s+du|gider\s+du|må\s+jeg\s+bede\s+dig\s+om\s+at|du\s+skal(?:\s+huske\s+at)?|husk(?:\s+at)?|glem\s+ikke\s+at|send\s+(?:mig|os)|giv\s+(?:mig|os)\s+besked|lad\s+(?:mig|os)\s+høre|vi\s+skal\s+have\s+(?:et\s+|en\s+)?(?:svar|ja|besked)|let\s+(?:me|us)\s+know|vi\s+mangler|jeg\s+mangler|can\s+you|could\s+you|would\s+you|will\s+you|please(?!\s+(?:find|see|note|be\s+aware|contact|do\s+not\s+reply|ignore))|pls|remember\s+to|don'?t\s+forget\s+to|make\s+sure\s+(?:to|you)|i\s+need\s+you\s+to|we\s+need|deadline(?:\s+is)?|due\s+(?:on|by))(?![\p{L}])/giu;
const PROMISE = /(?<![\p{L}])(jeg\s+(?:skal\s+nok|vil|lover\s+at|lover\s+dig\s+at|kommer\s+og|sender|betaler|afleverer|giver|returnerer|tager|ringer|kommer|henter|ordner|svarer|overfører|mobilepayer|skriver)|det\s+skal\s+jeg\s+nok|det\s+ordner\s+jeg|vi\s+(?:sender|betaler|afleverer|kommer|skal\s+nok)|i'?ll|i\s+will|i\s+promise(?:\s+to)?|i'?m\s+going\s+to|i\s+am\s+going\s+to|we'?ll|we\s+will|let\s+me\s+(?:send|get|check))(?![\p{L}])/giu;

/** The "who" part of a promise cue, before its verb. */
const PRONOUN = /^(?:det\s+skal\s+jeg\s+nok|det\s+ordner\s+jeg|jeg\s+(?:skal\s+nok|vil|lover\s+(?:dig\s+)?at|kommer\s+og)|jeg|vi\s+skal\s+nok|vi|i'?ll|i\s+will|i\s+promise(?:\s+to)?|i'?m\s+going\s+to|i\s+am\s+going\s+to|we'?ll|we\s+will|let\s+me)\s*/i;

const VERB_KINDS: [RegExp, CommitmentKind][] = [
  [/(?<![\p{L}])(betal|betaler|betale|overfør|overføre|mobilepay|pay|paying|transfer|refund|tilbagebetal|skylder|owe)/iu, "payment"],
  [/(?<![\p{L}])(returnere|returnerer|aflevere\s+[\p{L} ]{0,30}tilbage|afleverer\s+[\p{L} ]{0,30}tilbage|give\s+[\p{L} ]{0,30}tilbage|giver\s+[\p{L} ]{0,30}tilbage|return|bring\s+[\p{L} ]{0,30}back|give\s+[\p{L} ]{0,30}back)/iu, "return"],
  [/(?<![\p{L}])(svar|svare|svarer|vend\s+tilbage|giv\s+besked|reply|respond|answer|get\s+back\s+to|let\s+(?:me|us)\s+know)/iu, "reply"],
  [/(?<![\p{L}])(underskriv|underskrive|udfyld|udfylde|tilmeld|tilmelde|sign|fill\s+in|fill\s+out|register|book)/iu, "form"],
  [/(?<![\p{L}])(send|sende|sender|aflever|aflevere|afleverer|medbring|tag\s+[\p{L} ]{0,30}med|tage\s+[\p{L} ]{0,30}med|bring|deliver|hand\s+in|drop\s+off|share|upload|mail)/iu, "deliver"],
  [/(?<![\p{L}])(mødes|møde|komme\s+forbi|kommer\s+forbi|ses|meet|meeting|come\s+over|pick\s+(?:you|her|him|them)\s+up|hente)/iu, "appointment"],
];

export function kindOfAction(text: string): CommitmentKind {
  for (const [re, k] of VERB_KINDS) if (re.test(text)) return k;
  return "other";
}

/** Cut a quoted reply off an email body ("> …", "On … wrote:", "Den … skrev …:", "-----Original Message-----"). */
export function stripQuoted(body: string): string {
  const lines = body.split("\n");
  const out: string[] = [];
  for (const l of lines) {
    if (/^\s*>/.test(l)) break;
    if (/^\s*(?:On\s.+wrote:|Den\s.+skrev.*:|-{2,}\s*(?:Original Message|Oprindelig meddelelse|Forwarded message|Videresendt meddelelse)\s*-{2,}|Fra:\s.+|From:\s.+<.+@.+>.*)\s*$/i.test(l) && out.length > 3) break;
    out.push(l);
  }
  return out.join("\n");
}

/** "Kan du sende kontrakten inden fredag" → "send kontrakten". */
function actionOf(sentence: string, cueEnd: number, whenText: string | null): string | null {
  let s = sentence.slice(cueEnd);
  if (whenText) {
    const i = s.toLowerCase().indexOf(whenText.toLowerCase());
    if (i >= 0) s = s.slice(0, i) + s.slice(i + whenText.length);
  }
  s = s.replace(/^(?:\s*(?:at|to|lige|godt|nok|også|venligst|please|just)\b)+/i, "").replace(/\s+(?:på|til|senest|inden|den|by|on|before|i|in)\s*$/i, "")
    .replace(/[\s,.!?:;–-]+$/, "").replace(/^\s*[,:–-]\s*/, "").trim();
  if (s.length < 3) return null;
  return s.length > 90 ? `${s.slice(0, 89).trimEnd()}…` : s;
}

type Line = { author: string | null; text: string; day: Day; region?: string; page?: number; offset: number; segText: string };

/** Chat lines with their author and day. */
export function chatLines(input: DetectInput): Line[] {
  const out: Line[] = [];
  for (const seg of input.segments) {
    const head = /^[^\n]*·\s*(\d{4})-(\d{2})-(\d{2})(?:\s*\(\d+\))?\s*$/m.exec(seg.text.split("\n")[0] ?? "");
    const day: Day = head ? { year: +head[1], month: +head[2], day: +head[3] } : anchorOf(input.docDate, input.now);
    let offset = 0;
    for (const raw of seg.text.split("\n")) {
      const m = /^(\d{1,2}:\d{2})\s+([^:]{1,60}):\s(.+)$/.exec(raw);
      if (m) out.push({ author: m[2].trim(), text: m[3], day, ...(seg.region ? { region: seg.region } : {}), ...(seg.page ? { page: seg.page } : {}), offset: offset + raw.indexOf(m[3]), segText: seg.text });
      offset += raw.length + 1;
    }
  }
  return out;
}

const isMe = (author: string | null, self: DetectInput["self"]) => {
  if (!author) return false;
  const a = author.trim().toLowerCase();
  if (a === "me" || a === "mig" || a === "du" || a === "you") return true;
  // "Anna" signed in, "Anna Hansen" in the chat (or the other way round).
  return !!self?.names.some((n) => {
    const s = n?.trim().toLowerCase();
    return !!s && (s === a || s.split(" ")[0] === a || (!s.includes(" ") && a.split(" ")[0] === s));
  });
};

/** Requests and promises in one piece of text written by `author` (null = unknown) on `day`. */
function scan(text: string, opts: { day: Day; fromMe: boolean; author: Party | null; addressee: Party | null; chat: boolean; page?: number; region?: string }): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<number>();
  for (const [re, type] of [[REQUEST, "request"], [PROMISE, "promise"]] as const) {
    const r = new RegExp(re.source, re.flags);
    for (let m = r.exec(text); m; m = r.exec(text)) {
      const sentence = sentenceAt(text, m.index, m[0].length);
      const start = text.indexOf(sentence);
      if (seen.has(start)) continue;
      const whens = allWhens(sentence, opts.day);
      const when = whens.find((w) => w.index > sentence.indexOf(m![0]) - 40) ?? whens[0];
      const soon = !when && type === "request" && SOON.test(sentence);
      if (!when && !soon) continue;
      // A question about the past ("kunne du nå det i går?") or a plain question about plans is not a commitment.
      if (/(?<![\p{L}])(i\s+går|yesterday|sidste\s+uge|last\s+week)(?![\p{L}])/iu.test(sentence)) continue;
      const cueAt = sentence.toLowerCase().indexOf(m[0].toLowerCase());
      // A promise's verb is part of what was promised ("Jeg betaler dig tilbage" → "betaler dig tilbage").
      const pron = type === "promise" ? PRONOUN.exec(m[0]) : null;
      const action = actionOf(sentence, cueAt + (pron ? pron[0].length : m[0].length), when?.text ?? null);
      if (!action && !/deadline|due/i.test(m[0])) continue;
      const kind = kindOfAction(`${m[0]} ${action ?? ""}`);
      seen.add(start);
      // Who acts: a request is for the one it's sent to; a promise is the writer's.
      let owner: OwnerHint, direction: Candidate["direction"], counterparty: Party | null;
      if (type === "request") {
        if (opts.fromMe) { owner = opts.addressee ? { by: "person", name: opts.addressee.name, email: opts.addressee.email } : { by: "viewer" }; direction = "owed"; counterparty = opts.addressee; }
        else { owner = { by: "viewer" }; direction = "owe"; counterparty = opts.author; }
      } else {
        if (opts.fromMe) { owner = { by: "viewer" }; direction = "promise"; counterparty = opts.addressee; }
        else { owner = opts.author ? { by: "person", name: opts.author.name, email: opts.author.email } : { by: "viewer" }; direction = "promise"; counterparty = null; }
      }
      // "Remember to pay" said to the reader's other parent etc.: a request the reader sent stays theirs to chase.
      if (type === "request" && opts.fromMe && !opts.addressee) continue;
      out.push({
        detector: "message", kind, direction, dueAt: when ? dueIso(when.day) : null, dueDay: when ? dayKey(when.day) : null,
        dueKind: when ? (when.dueKind === "date" && type === "request" ? "deadline" : when.dueKind) : "approx", dueWords: when?.words ?? (soon ? SOON.exec(sentence)?.[0] ?? null : null),
        counterparty, action, owner, quote: sentence, ...(opts.page ? { page: opts.page } : {}), ...(opts.region ? { region: opts.region } : {}),
        confidence: when ? (when.dueKind === "approx" ? 0.55 : 0.65) : 0.45,
      });
    }
  }
  return out;
}

export function messageCandidates(input: DetectInput): Candidate[] {
  const today = copenhagenDay(input.now);
  if (input.sourceKind === "chat") {
    const lines = chatLines(input);
    const authors = [...new Set(lines.map((l) => l.author).filter((a): a is string => !!a))];
    const others = authors.filter((a) => !isMe(a, input.self));
    const out: Candidate[] = [];
    const since = addDays(today, -CHAT_LOOKBACK_DAYS);
    for (const l of lines) {
      if (compareDays(l.day, since) < 0) continue;
      const fromMe = isMe(l.author, input.self);
      const author: Party | null = l.author && !fromMe ? { name: l.author, type: "person" } : null;
      // In a one-to-one chat the other person is the addressee; in a group it is unclear.
      const addressee: Party | null = fromMe && others.length === 1 ? { name: others[0], type: "person" } : null;
      for (const c of scan(l.text, { day: l.day, fromMe, author, addressee, chat: true, region: l.region, page: l.page })) {
        // Keep only those still ahead (or just missed): a promise for last month is history.
        if (c.dueDay && c.dueDay < dayKey(addDays(today, -14))) continue;
        out.push(c);
      }
    }
    return out;
  }
  if (input.sourceKind !== "email" && input.sourceKind !== "message") return [];
  const full = input.segments.map((s) => s.text).join("\n\n");
  const bodyAt = input.sourceKind === "email" ? full.search(/\n\s*\n/) : -1;
  const body = stripQuoted(bodyAt > 0 ? full.slice(bodyAt) : full);
  const anchor = anchorOf(input.docDate, input.now);
  const selfEmails = new Set((input.self?.emails ?? []).map((e) => e.toLowerCase()));
  const from = input.email?.from ?? null;
  const fromMe = !!from && selfEmails.has(from.email.toLowerCase());
  const author: Party | null = from && !fromMe ? { name: from.name || from.email, type: "person", email: from.email } : null;
  const to = (input.email?.to ?? []).filter((t) => !selfEmails.has(t.email.toLowerCase()));
  const addressee: Party | null = fromMe && to.length === 1 ? { name: to[0].name || to[0].email, type: "person", email: to[0].email } : null;
  // Only when the email is to the reader (or from them): a newsletter's "remember to …" is not a request.
  if (!fromMe && input.email?.to?.length && selfEmails.size && !input.email.to.some((t) => selfEmails.has(t.email.toLowerCase()))) return [];
  if (from && /^(no-?reply|noreply|do-?not-?reply|newsletter|nyhedsbrev|marketing|info|news)@/i.test(from.email)) return [];
  return scan(body, { day: anchor, fromMe, author, addressee, chat: false });
}

/* ── Calendar invitations waiting for an answer ──────────────────────────────────────────────────────────── */

const INVITE_SUBJECT = /^(?:(?:updated\s+)?invitation|invitation\s+til|indkaldelse|mødeindkaldelse|opdateret\s+invitation|invitasjon)\s*:?\s*/i;
const RSVP = /(?<![\p{L}])(rsvp|going\?|will\s+you\s+attend|please\s+respond|svar\s+venligst|deltager\s+du|kommer\s+du|accept\s*[|·/]\s*(?:tentative|maybe|decline)|ja\s*[|·/]\s*måske\s*[|·/]\s*nej|yes\s*[|·/]\s*maybe\s*[|·/]\s*no)(?![\p{L}])/iu;

export function invitationCandidates(input: DetectInput): Candidate[] {
  if (input.sourceKind !== "email") return [];
  const subject = input.email?.subject ?? "";
  const full = input.segments.map((s) => s.text).join("\n\n");
  const vcal = /BEGIN:VCALENDAR[\s\S]*?METHOD:REQUEST/i.test(full);
  if (!(INVITE_SUBJECT.test(subject) && RSVP.test(full)) && !vcal) return [];
  const anchor = anchorOf(input.docDate, input.now);
  const when = /(?:^|\n)\s*(?:when|hvornår|tidspunkt|dato|date)\s*:?\s*([^\n]{4,120})/i.exec(full);
  const by = /(?:rsvp|svar(?:\s+venligst)?|respond|reply)\s+(?:by|senest|inden|before)\s+([^\n]{3,60})/i.exec(full);
  const dt = by ? allWhens(by[1], anchor)[0] : when ? allWhens(when[1], anchor)[0] : null;
  if (!dt) return [];
  const title = subject.replace(INVITE_SUBJECT, "").replace(/\s*@.*$/, "").trim() || null;
  const quote = (by?.[0] ?? when?.[0] ?? "").trim();
  if (!quote) return [];
  // Answer before the event: a day before it, or by the RSVP day.
  const day = by ? dt.day : addDays(dt.day, -1);
  const from = input.email?.from;
  return [{
    detector: "calendar", kind: "reply", flavor: "invitation", direction: "owe", dueAt: dueIso(day), dueDay: dayKey(day), dueKind: "deadline",
    counterparty: from ? { name: from.name || from.email, type: "person", email: from.email } : null, subject: title, owner: { by: "viewer" },
    quote, confidence: 0.7,
  }];
}
