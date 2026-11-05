/**
 * Digital Post notices (pure). There is no official way for a citizen's own app to read Digital Post, so the
 * reliable route is the email every Dane can turn on: "Du har modtaget ny post …" from mit.dk, e-Boks or Digital
 * Post. Gmail, Outlook and IMAP already bring those emails in as email sources; this recognises one and proposes a
 * reminder to open the letter, naming the sender when the email says who it is from. The letter itself stays in
 * mit.dk / e-Boks (see connectors/dk/digital-post for why there is no direct sync yet).
 */
import type { ChangeInput } from "@/lib/changes";
import { authorityFromPhrase } from "./authorities";

export type DigitalPostService = "mit.dk" | "e-Boks" | "Digital Post";

export type DigitalPostNotice = {
  service: DigitalPostService;
  /** Who sent the letter, when the email says ("Skattestyrelsen"), as an authority's known name when it is one. */
  sender: string | null;
  /** The letter's own title, when the email gives it ("Årsopgørelse 2025"). */
  letterTitle: string | null;
  /** The line of the email that says so, for the receipt. */
  quote: string;
};

export type EmailFacts = { from?: string | null; subject?: string | null; date?: string | null };

/** Domains that send the notices (and nothing else of interest). */
const SENDER_DOMAINS: { re: RegExp; service: DigitalPostService }[] = [
  { re: /@(?:[\w-]+\.)*mit\.dk\b/i, service: "mit.dk" },
  { re: /@(?:[\w-]+\.)*e-?boks\.(?:dk|com)\b/i, service: "e-Boks" },
  { re: /@(?:[\w-]+\.)*digitalpost\.dk\b/i, service: "Digital Post" },
  { re: /@(?:[\w-]+\.)*(?:borger\.dk|nemlog-in\.dk)\b/i, service: "Digital Post" },
];

/** The words a notice says it with, in Danish and English. */
const NEW_MAIL = /\b(?:du\s+har\s+(?:modtaget|fået)\s+(?:ny\s+)?(?:post|digital\s+post|et\s+(?:nyt\s+)?brev|en\s+(?:ny\s+)?meddelelse)|ny\s+post\s+(?:fra|i|til)|nyt\s+brev\s+(?:fra|i)|you\s+have\s+(?:received\s+)?(?:new\s+)?(?:mail|post|a\s+(?:new\s+)?letter))/i;
const SERVICE_WORDS: { re: RegExp; service: DigitalPostService }[] = [
  { re: /\bmit\.dk\b/i, service: "mit.dk" },
  { re: /\be-?boks\b/i, service: "e-Boks" },
  { re: /\bdigital\s*post\b/i, service: "Digital Post" },
];

/** "post fra Skattestyrelsen", "Afsender: Aarhus Kommune", "from Udbetaling Danmark". */
const SENDER_PATTERNS = [
  /\b(?:afsender|fra|from|sender)\s*:\s*([^\n]{2,80})/i,
  /\b(?:post|brev|meddelelse|mail|letter)\s+fra\s+([^\n]{2,80}?)(?=\s+(?:i|på|til|via|in)\s|[.,:;!\n]|$)/i,
  /\b(?:mail|post|letter|message)\s+from\s+([^\n]{2,80}?)(?=\s+(?:in|on|to|via)\s|[.,:;!\n]|$)/i,
];
const TITLE_PATTERNS = [
  /\b(?:emne|titel|overskrift|subject|title)\s*:\s*([^\n]{2,120})/i,
];

/** Senders that are the service itself, not the authority behind the letter. */
const NOT_A_SENDER = /^(?:mit\.dk|e-?boks|digital\s*post|borger\.dk|noreply|no-reply|din\s+digitale\s+postkasse|.*@.*)$/i;

function emailAddress(from: string | null | undefined): string {
  const m = /<([^>]+)>/.exec(from ?? "");
  return (m ? m[1] : from ?? "").trim();
}

const clean = (s: string) => s.replace(/["“”«»]/g, "").replace(/\s+/g, " ").trim().replace(/[.,;:]+$/, "");

/**
 * The notice this email is, or null. Certain on purpose: the email must come from the service's own domain, or say
 * "you have new mail" in its subject while naming the service.
 */
export function classifyDigitalPostEmail(email: EmailFacts, text_: string): DigitalPostNotice | null {
  // The stored text of an email starts with its own header lines (Subject:, From: …); only the body is read.
  const body = text_.replace(/^(?:(?:Subject|From|To|Cc|Date|Attachments): [^\n]*\n)+\n?/, "");
  const addr = emailAddress(email.from);
  const subject = (email.subject ?? "").trim();
  const text = `${subject}\n${body}`.slice(0, 20_000);
  let service = SENDER_DOMAINS.find((d) => d.re.test(addr))?.service ?? null;
  if (service) {
    // From the service's domain but not a notice (a newsletter, a password reset): skip.
    if (!NEW_MAIL.test(text)) return null;
  } else {
    if (!NEW_MAIL.test(subject)) return null;
    service = SERVICE_WORDS.find((w) => w.re.test(text))?.service ?? null;
    if (!service) return null;
  }
  // A more specific service named in the text (a notice from digitalpost.dk that says "mit.dk") keeps the domain's.
  let sender: string | null = null;
  let quote = "";
  for (const re of SENDER_PATTERNS) {
    for (const part of [subject, body]) {
      const m = re.exec(part);
      if (!m) continue;
      const phrase = clean(m[1]);
      if (!phrase || NOT_A_SENDER.test(phrase) || phrase.length > 80) continue;
      sender = authorityFromPhrase(phrase).name;
      quote = lineOf(part, m.index);
      break;
    }
    if (sender) break;
  }
  let letterTitle: string | null = null;
  for (const re of TITLE_PATTERNS) {
    const m = re.exec(body);
    if (m) { letterTitle = clean(m[1]).slice(0, 120) || null; break; }
  }
  if (!quote) {
    const m = NEW_MAIL.exec(subject) ?? NEW_MAIL.exec(body);
    quote = m ? lineOf(m.input, m.index) : subject;
  }
  return { service, sender, letterTitle, quote: quote.slice(0, 300) };
}

function lineOf(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end < 0 ? undefined : end).replace(/\s+/g, " ").trim();
}

const OPEN_IN: Record<DigitalPostService, string> = { "mit.dk": "mit.dk", "e-Boks": "e-Boks", "Digital Post": "mit.dk / e-Boks" };

/** The reminder text for a notice, in the reader's language. */
export function noticeReminderTitle(n: DigitalPostNotice, locale: "en" | "da"): string {
  const where = OPEN_IN[n.service];
  if (locale === "da") {
    return n.sender ? `Nyt brev fra ${n.sender} i Digital Post – åbn det i ${where}` : `Nyt brev i Digital Post – åbn det i ${where}`;
  }
  return n.sender ? `New letter from ${n.sender} in Digital Post — open it in ${where}` : `New letter in Digital Post — open it in ${where}`;
}

/**
 * The reminder for a notice: due 18 hours after the email arrived (the next morning), or at once for an older email
 * read late or one without a date. The receipt quotes the line of the email that says so.
 */
export function digitalPostOps(n: DigitalPostNotice, ctx: { sourceId: string; sentAt: Date | null; now: Date; locale: "en" | "da"; aboutNodeId?: string | null }): ChangeInput[] {
  const sent = ctx.sentAt && !Number.isNaN(ctx.sentAt.getTime()) ? ctx.sentAt.getTime() : null;
  const due = new Date(sent === null ? ctx.now.getTime() : Math.max(sent + 18 * 3600_000, ctx.now.getTime()));
  const detail = [
    n.letterTitle ? (ctx.locale === "da" ? `Brevets titel: ${n.letterTitle}.` : `The letter's title: ${n.letterTitle}.`) : null,
    ctx.locale === "da"
      ? "Selve brevet ligger i din digitale postkasse; My Graph kan ikke læse det derfra. Gem det som PDF og del det med My Graph, så læser den frister og afsender."
      : "The letter itself is in your digital mailbox; My Graph can't read it there. Save it as a PDF and share it with My Graph to have its deadlines and sender read.",
  ].filter(Boolean).join(" ");
  return [{
    op: "addReminder",
    title: noticeReminderTitle(n, ctx.locale),
    dueAt: due.toISOString(),
    aboutNodeId: ctx.aboutNodeId ?? null,
    detail,
    note: `A ${n.service} notice: a new letter${n.sender ? ` from ${n.sender}` : ""} is waiting in Digital Post.`,
    receipt: { sourceId: ctx.sourceId, quote: n.quote, confidence: n.sender ? 0.9 : 0.8 },
  }];
}
