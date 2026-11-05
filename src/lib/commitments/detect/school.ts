/**
 * School messages (Aula, MinUddannelse, the class's weekly letter, an email from the teacher) — pure. Things a parent
 * has to do by a day: bring something ("medbring", "husk … med", "tag … med", "skal have … med", "bring"), sign up
 * or fill in ("tilmelding senest", "tilmeld jer", "udfyld", "underskriv", "sign up by"), hand something in
 * ("aflever", "hand in"), answer ("svar senest"), or come to a meeting ("forældremøde", "skole-hjem-samtale").
 * Only with a day (a date, a weekday, "i morgen"): "husk madpakke" with no day is not a commitment.
 * Owner: a parent of the child it concerns (resolved against the graph), else the reader.
 */
import { dkRe } from "@/lib/importers/dk/authorities";
import { sentenceAt, type Candidate, type DetectInput } from "./candidate";
import { allWhens, anchorOf, dayKey, dueIso } from "./when";
import type { CommitmentKind } from "../types";

const SCHOOL_CONTEXT = dkRe(String.raw`\b(aula|skole|skolen|klasse|klassen|elev|elever|lærer|klasselærer|pædagog|sfo|fritidshjem|børnehave|vuggestue|dagpleje|institution|forældre|forældremøde|lejrskole|ekskursion|udflugt|minuddannelse|meebook|ugeplan|ugebrev|school|class|teacher|parents|field\s+trip|kindergarten|nursery)\b`, "i");

type Cue = { re: RegExp; kind: CommitmentKind };
const CUES: Cue[] = [
  { re: dkRe(String.raw`\b(tilmelding(?:en)?(?:\s+[\p{L}\d.]+){0,5}?\s+(?:senest|inden)|tilmeld\s+(?:jer|dig|jeres\s+barn|dit\s+barn)|sign\s+up\s+(?:by|before)|register\s+(?:by|before)|rsvp\s+by)`, "i"), kind: "form" },
  { re: dkRe(String.raw`\b(udfyld(?:es)?|underskriv(?:es)?|underskrevet|samtykke(?:erklæring)?|fill\s+in|fill\s+out|sign\s+(?:and\s+return|the\s+form|the\s+consent))`, "i"), kind: "form" },
  { re: dkRe(String.raw`\b(medbring(?:e|es)?|husk\s+(?:at\s+)?(?:tage|at\s+tage|at\s+have|madpakke|drikkedunk|regntøj|gummistøvler|idrætstøj|skiftetøj|cykel|cykelhjelm|madkurv|penge|kontanter|sovepose|pas)|tag\s+[\p{L} ,]{2,40}\s+med|skal\s+have\s+[\p{L} ,]{2,40}\s+med|please\s+bring|remember\s+to\s+bring|bring\s+(?:a|an|their|your)\b)`, "i"), kind: "deliver" },
  { re: dkRe(String.raw`\b(aflever(?:es)?|afleveringsfrist|hand\s+in|due\s+in|turn\s+in)`, "i"), kind: "deliver" },
  { re: dkRe(String.raw`\b(svar\s+(?:venligst\s+)?(?:senest|inden)|giv\s+besked\s+(?:senest|inden)|let\s+us\s+know\s+by|reply\s+by)`, "i"), kind: "reply" },
  { re: dkRe(String.raw`\b(forældremøde|forældresamtale|skole-?hjem-?samtale|forældrekonsultation|parents'?\s+(?:meeting|evening)|parent-teacher)`, "i"), kind: "appointment" },
  { re: dkRe(String.raw`\b(husk\s+at\s+betale|betal(?:ing)?\s+(?:senest|inden)|indbetal\s+(?:senest|inden)|mobilepay\s+[\p{L} ]{0,20}(?:senest|inden))`, "i"), kind: "payment" },
];

/** "Medbring madpakke og regntøj på fredag." → "Medbring madpakke og regntøj". */
function actionOf(sentence: string, cueIndex: number, whenText: string | null): string {
  // "Giv samtykke i Aula …": a verb or two before the cue belong to what has to be done.
  const before = sentence.slice(0, cueIndex).trim();
  let s = before && before.split(/\s+/).length <= 2 && !/[,:;]/.test(before) ? sentence : sentence.slice(cueIndex);
  if (whenText) {
    const i = s.toLowerCase().indexOf(whenText.toLowerCase());
    if (i > 8) s = s.slice(0, i);
  }
  // Drop the time words left at the end ("senest mandag den", "på fredag", "by Friday").
  s = s.replace(/(?:\s+(?:på|til|senest|inden|den|by|on|before|no\s+later\s+than|(?:man|tirs|ons|tors|fre|lør|søn)dag(?:en)?|(?:mon|tues|wednes|thurs|fri|satur|sun)day))+[\s,.!:;–-]*$/iu, "").replace(/[\s,.!:;–-]+$/, "").trim();
  return s.length > 90 ? `${s.slice(0, 89).trimEnd()}…` : s;
}

export function schoolCandidates(input: DetectInput): Candidate[] {
  const full = input.segments.map((s) => s.text).join("\n\n");
  if (input.sourceKind === "chat" || !SCHOOL_CONTEXT.test(full.slice(0, 8000) + " " + input.title)) return [];
  const anchor = anchorOf(input.docDate, input.now);
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const seg of input.segments) {
    for (const cue of CUES) {
      const re = new RegExp(cue.re.source, cue.re.flags.includes("g") ? cue.re.flags : cue.re.flags + "g");
      for (let m = re.exec(seg.text); m; m = re.exec(seg.text)) {
        const sentence = sentenceAt(seg.text, m.index, m[0].length);
        const when = allWhens(sentence, anchor)[0];
        if (!when) continue;
        const at = sentence.indexOf(m[0]);
        const action = cue.kind === "appointment" ? null : actionOf(sentence, Math.max(0, at), when.text);
        const key = `${cue.kind}|${dayKey(when.day)}|${(action ?? "").toLowerCase().slice(0, 30)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const subject = cue.kind === "appointment" ? m[0].toLowerCase() : null;
        out.push({
          detector: "school", kind: cue.kind, direction: "owe", dueAt: dueIso(when.day), dueDay: dayKey(when.day),
          dueKind: when.dueKind, dueWords: when.words, counterparty: input.email?.from ? { name: input.email.from.name || input.email.from.email, type: "person", email: input.email.from.email } : null,
          subject, action, owner: { by: "about" }, quote: sentence, ...(seg.page ? { page: seg.page } : {}), ...(seg.region ? { region: seg.region } : {}),
          confidence: when.dueKind === "approx" ? 0.6 : 0.75,
        });
      }
    }
  }
  return out;
}
