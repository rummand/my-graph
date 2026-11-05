/**
 * Letters (pure): Danish public letters (src/lib/importers/dk/public-letter.ts already finds the sender, the kind of
 * letter and its dated deadlines) become commitments instead of plain reminders: a svarfrist is a reply, a
 * betalingsfrist a payment, a klagefrist the last day to appeal, an indkaldelse an appointment. Deadlines the letter
 * gives relative to itself ("inden 14 dage fra modtagelsen", "senest 8 dage efter brevets dato") count from the
 * letter's date. Each candidate quotes the sentence it comes from.
 */
import { classifyPublicLetter, type Deadline, type PublicLetter } from "@/lib/importers/dk/public-letter";
import { dkRe } from "@/lib/importers/dk/authorities";
import { amountsIn } from "./amount";
import { sentenceAt, type Candidate, type DetectInput, type Flavor } from "./candidate";
import { allWhens, anchorOf, dayKey, dueIso, type Day } from "./when";
import type { CommitmentKind } from "../types";

/** "Vedr.: Skolebuskort til Emma", "Partshøring om skolebuskort", "Emne: …": what the letter is about. */
export function letterSubject(text: string): string | null {
  const head = text.slice(0, 3000);
  const labelled = /(?:^|\n)\s*(?:vedr\.?|vedrørende|angående|emne|om|sag|re|subject|regarding)\s*:\s*([^\n]{3,90})/iu.exec(head);
  if (labelled) return tidy(labelled[1]);
  const about = dkRe(String.raw`\b(?:partshøring|afgørelse|ansøgning|bevilling|afslag|indkaldelse|opkrævning|klage)\s+(?:om|vedr\.?|vedrørende|angående|på|af)\s+([^\n.,;:]{3,70})`, "i").exec(head);
  if (about) return tidy(about[1]);
  return null;
}

const tidy = (s: string) => s.replace(/\s+/g, " ").replace(/[.,;:]+$/, "").trim().replace(/^(din|jeres|your)\s+/i, "");

/** What happens if it's missed, when the letter says so ("Hvis du ikke svarer, …"). */
export function consequenceIn(text: string): string | null {
  const m = /(?<![\p{L}])(?:hvis\s+(?:du|i)\s+ikke\s+(?:svarer|betaler|indsender|sender|reagerer|møder)|if\s+you\s+do\s+not\s+(?:reply|pay|respond|answer)|if\s+we\s+do\s+not\s+hear)[^.\n]{5,220}[.]?/iu.exec(text);
  return m ? m[0].replace(/\s+/g, " ").trim() : null;
}

function kindFor(d: Deadline, l: PublicLetter): { kind: CommitmentKind; flavor: Flavor } {
  switch (d.kind) {
    case "reply": return { kind: l.type === "school_enrolment" ? "form" : "reply", flavor: l.type === "hearing" ? "hearing" : null };
    case "payment": return { kind: "payment", flavor: null };
    case "complaint": return { kind: "notice", flavor: "complaint" };
    case "appointment": return { kind: "appointment", flavor: null };
    default:
      if (/\b(?:udfyld|indsend|ansøg|tilmeld|indberet|underskriv|ret\s+(?:din|dine))/i.test(d.quote) || l.type === "school_enrolment") return { kind: "form", flavor: null };
      if (l.type === "hearing") return { kind: "reply", flavor: "hearing" };
      return { kind: "reply", flavor: null };
  }
}

/** The letter's deadlines as commitments. `letter` may be given (the pipeline read it already). */
export function letterCandidates(input: DetectInput, letter?: PublicLetter | null): Candidate[] {
  if (input.sourceKind === "email" || input.sourceKind === "chat") return [];
  const l = letter ?? classifyPublicLetter(input.segments.map((s) => ({ text: s.text, page: s.page })), input.now);
  if (!l) return [];
  const full = input.segments.map((s) => s.text).join("\n\n");
  const subject = letterSubject(full);
  const consequence = consequenceIn(full);
  const counterparty = { name: l.authority.name, type: "organization" as const };
  const out: Candidate[] = [];
  const days = new Set<string>();
  for (const d of l.deadlines) {
    const { kind, flavor } = kindFor(d, l);
    const day: Day = { year: d.date.year, month: d.date.month, day: d.date.day, ...(d.date.hour !== undefined ? { hour: d.date.hour, minute: d.date.minute ?? 0 } : {}) };
    days.add(`${kind}|${dayKey(day)}`);
    const sentence = d.quote;
    const amount = kind === "payment" ? nearestAmount(sentence, full) : null;
    out.push({
      detector: "letter", kind, flavor, direction: "owe", dueAt: dueIso(day), dueDay: dayKey(day), dueKind: kind === "appointment" ? "date" : "deadline",
      amount, consequence: kind === "appointment" ? null : consequence, counterparty, subject, owner: { by: "viewer" },
      quote: sentence, ...(d.page ? { page: d.page } : {}), confidence: 0.9,
    });
  }
  // Relative deadlines: "Du skal svare inden 14 dage fra modtagelsen af dette brev."
  const anchor = anchorOf(input.docDate, input.now);
  for (const seg of input.segments) {
    const re = /(?<![\p{L}])(svar|svarfrist|frist|betal|indbetal|klage|send|indsend|udfyld|bemærkninger|reply|respond|pay|appeal)/giu;
    for (let m = re.exec(seg.text); m; m = re.exec(seg.text)) {
      const sentence = sentenceAt(seg.text, m.index, m[0].length);
      const rel = allWhens(sentence, anchor).find((w) => w.words && w.dueKind === "deadline" && /\d|en|to|tre|fire|fem|seks|otte|fjorten|one|two|three|four|fourteen/i.test(w.words) && /dage|uger|måned|days|weeks|month/i.test(w.words));
      if (!rel) continue;
      const lead = m[1].toLowerCase();
      const kind: CommitmentKind = /betal|pay/.test(lead) || /\b(?:betal|beløb|kr\.)/i.test(sentence) ? "payment" : /klage|appeal/.test(lead) ? "notice" : /udfyld/.test(lead) ? "form" : "reply";
      const key = `${kind}|${dayKey(rel.day)}`;
      if (days.has(key)) continue;
      days.add(key);
      out.push({
        detector: "letter", kind, flavor: kind === "notice" ? "complaint" : l.type === "hearing" && kind === "reply" ? "hearing" : null, direction: "owe",
        dueAt: dueIso(rel.day), dueDay: dayKey(rel.day), dueKind: "deadline", dueWords: rel.words,
        amount: kind === "payment" ? nearestAmount(sentence, full) : null, consequence, counterparty, subject, owner: { by: "viewer" },
        quote: sentence, ...(seg.page ? { page: seg.page } : {}),
        // Counted from the letter's own date when it has one; from today (a little less sure) when it has none.
        confidence: input.docDate ? 0.8 : 0.65,
      });
    }
  }
  return out;
}

/** The amount in the sentence, else the one labelled as the amount to pay in the whole letter. */
export function nearestAmount(sentence: string, full: string): { value: number; currency: string } | null {
  const a = amountsIn(sentence)[0];
  if (a) return { value: a.value, currency: a.currency };
  const labelled = /(?:beløb(?:et)?(?:\s+at\s+betale)?|at\s+betale|i\s+alt|total(?:\s+due)?|amount\s+due|til\s+betaling|restgæld|skyldigt\s+beløb)\s*:?\s*([^\n]{0,40})/giu;
  for (let m = labelled.exec(full); m; m = labelled.exec(full)) {
    const x = amountsIn(m[1])[0];
    if (x) return { value: x.value, currency: x.currency };
  }
  return null;
}
