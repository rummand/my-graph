/**
 * A commitment's label: one plain sentence in the reader's language (pure). "Svar Vejle Kommune om skolebuskort" /
 * "Answer Vejle Kommune about skolebuskort". The subject stays in the source's own words; a model's label (which can
 * translate it) is used when the model found the commitment.
 */
import { sayAmount } from "./amount";
import type { Candidate, Locale } from "./candidate";

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export function commitmentLabel(c: Candidate, locale: Locale, names: { counterparty?: string | null; owner?: string | null } = {}): string {
  const model = c.label?.[locale]?.trim();
  if (model) return clip(model, 160);
  const cp = names.counterparty ?? c.counterparty?.name ?? null;
  const subj = c.subject?.trim() || null;
  const act = c.action?.trim() || null;
  const owner = names.owner ?? null;
  const amt = c.amount ? sayAmount(c.amount, locale) : null;
  const da = locale === "da";
  // Someone else promised it: say who.
  if (c.direction === "promise" && c.owner.by === "person" && owner) {
    return clip(da ? `${owner} har lovet: ${act ?? subj ?? c.kind}` : `${owner} promised: ${act ?? subj ?? c.kind}`, 160);
  }
  // The reader promised it: say to whom, in the words they used.
  if (c.direction === "promise" && c.owner.by === "viewer" && act) {
    return clip(da ? `Lovet${cp ? ` ${cp}` : ""}: ${act}` : `Promised${cp ? ` ${cp}` : ""}: ${act}`, 160);
  }
  if (c.direction === "owed") {
    if (c.kind === "payment") return clip(da ? `${cp ?? "Nogen"} skal betale${amt ? ` ${amt}` : ""}${subj ? ` for ${subj}` : ""}` : `${cp ?? "Someone"} owes${amt ? ` ${amt}` : " a payment"}${subj ? ` for ${subj}` : ""}`, 160);
    if (c.kind === "return") return clip(da ? `${cp ?? "Nogen"} skal aflevere ${act ?? subj ?? "noget"} tilbage` : `${cp ?? "Someone"} is to return ${act ?? subj ?? "something"}`, 160);
  }
  let s: string;
  switch (c.kind) {
    case "reply":
      if (c.flavor === "invitation") s = da ? `Svar på invitationen${subj ? `: ${subj}` : ""}${cp ? ` fra ${cp}` : ""}` : `Answer the invitation${subj ? `: ${subj}` : ""}${cp ? ` from ${cp}` : ""}`;
      else if (c.flavor === "hearing") s = da ? `Svar ${cp ?? ""} på partshøringen${subj ? ` om ${subj}` : ""}` : `Answer ${cp ?? ""}'s consultation${subj ? ` about ${subj}` : ""}`;
      else s = da ? `Svar ${cp ?? "afsenderen"}${subj ? ` om ${subj}` : ""}` : `Answer ${cp ?? "the sender"}${subj ? ` about ${subj}` : ""}`;
      break;
    case "payment":
      s = da ? `Betal${amt ? ` ${amt}` : ""}${cp ? ` til ${cp}` : ""}${subj ? ` for ${subj}` : ""}` : `Pay ${cp ?? ""}${amt ? ` ${amt}` : ""}${subj ? ` for ${subj}` : ""}`;
      break;
    case "renewal":
      s = da ? `${cap(subj ?? "Aftalen")}${cp ? ` hos ${cp}` : ""} fornyes` : `${cap(subj ?? "The agreement")}${cp ? ` with ${cp}` : ""} renews`;
      break;
    case "notice":
      if (c.flavor === "complaint") s = da ? `Sidste frist for at klage over afgørelsen${cp ? ` fra ${cp}` : ""}${subj ? ` om ${subj}` : ""}` : `Last day to appeal ${cp ? `${cp}'s` : "the"} decision${subj ? ` about ${subj}` : ""}`;
      else s = da ? `Sidste frist for at opsige ${subj ?? "aftalen"}${cp ? ` hos ${cp}` : ""}` : `Last day to cancel ${subj ?? "the agreement"}${cp ? ` with ${cp}` : ""}`;
      break;
    case "appointment":
      s = da ? `${subj ? cap(subj) : "Tid"}${cp ? ` hos ${cp}` : ""}` : `${subj ? cap(subj) : "Appointment"}${cp ? ` with ${cp}` : ""}`;
      break;
    case "form":
      s = da ? `${cap(act ?? (subj ? `tilmeld/udfyld ${subj}` : "Udfyld formularen"))}${cp ? ` (${cp})` : ""}` : `${cap(act ?? (subj ? `sign up / fill in ${subj}` : "Fill in the form"))}${cp ? ` (${cp})` : ""}`;
      break;
    case "deliver":
      s = da ? `${cap(act ?? `send ${subj ?? "det aftalte"}`)}${cp && !act ? ` til ${cp}` : ""}` : `${cap(act ?? `send ${subj ?? "what was agreed"}`)}${cp && !act ? ` to ${cp}` : ""}`;
      break;
    case "return":
      s = da ? `Aflever ${act ?? subj ?? "det lånte"} tilbage${cp ? ` til ${cp}` : ""}` : `Return ${act ?? subj ?? "what was borrowed"}${cp ? ` to ${cp}` : ""}`;
      break;
    default:
      s = cap(act ?? subj ?? (da ? "Noget skal gøres" : "Something to do"));
  }
  return clip(s.replace(/\s+/g, " ").replace(/\s+([,.:)])/g, "$1").trim(), 160);
}

/** A short "why" for the reviewer, in English (change-set notes are stored in English and translated where shown). */
export function commitmentNote(c: Candidate, sourceTitle: string): string {
  const what: Record<string, string> = {
    letter: "A deadline in a letter", invoice: "A bill to pay", contract: "A date in an agreement", school: "Something school asks for",
    message: c.direction === "promise" ? "A promise in a message" : "A request in a message", calendar: "An invitation waiting for an answer",
    rule: "A time limit from an approved rule", model: "Found when reading",
  };
  const vague = c.dueKind === "approx" && c.dueWords ? ` (“${c.dueWords}”, so the date is a best guess)` : "";
  return `${what[c.detector] ?? "Found"} in “${sourceTitle.slice(0, 100)}”${vague}.`;
}
