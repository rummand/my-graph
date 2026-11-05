/**
 * Bills and invoices (pure): "Faktura", "Opkrævning", "Regning", "Invoice", with a due date ("Betalingsfrist",
 * "Forfaldsdato", "Sidste rettidige betalingsdag", "Betales senest", "Due date", "Pay by") and an amount ("Beløb",
 * "At betale", "I alt", "Total", "Amount due"). The payee is the labelled one ("Betales til", "Kreditor", "Payee"),
 * a company named with its legal form (A/S, ApS …) in the letterhead, or the email's sender.
 * A credit note or a receipt ("Kvittering", "Betalt", "Paid") is not a bill.
 */
import { dkRe } from "@/lib/importers/dk/authorities";
import { amountsIn } from "./amount";
import { sentenceAt, type Candidate, type DetectInput, type Party } from "./candidate";
import { anchorOf, datesIn, dayKey, dueIso } from "./when";

const BILL = dkRe(String.raw`\b(faktura|fakturanr|fakturanummer|opkrævning|regning|indbetalingskort|girokort|betalingsoversigt|invoice|bill\b|payment\s+request|statement\s+of\s+account|betalingspåmindelse|rykker)`, "i");
const NOT_A_BILL = dkRe(String.raw`\b(kreditnota|credit\s+note|kvittering\s+for\s+betaling|payment\s+received|betalingen\s+er\s+modtaget|er\s+betalt|has\s+been\s+paid|ordrebekræftelse|tilbud\s+nr|quote\s+no|betalt\s+med\s+kort|paid\s+by\s+card)`, "i");
const DUE = dkRe(String.raw`\b(betalingsfrist|forfaldsdato|forfalder(?:\s+til\s+betaling)?(?:\s+den)?|sidste\s+rettidige\s+betalingsdag|betales\s+senest|skal\s+være\s+betalt|betal(?:es)?\s+(?:venligst\s+)?(?:senest|inden)|indbetales\s+senest|due\s+date|payment\s+due|due\s+(?:on|by)|pay\s+by|please\s+pay\s+(?:by|before))\b`, "i");
const TOTAL = dkRe(String.raw`\b(beløb\s+at\s+betale|at\s+betale|til\s+betaling|i\s+alt|total\s+(?:due|amount|to\s+pay)|amount\s+due|balance\s+due|total|beløb|subtotal)\b`, "i");
const PAYEE = /(?:^|\n)\s*(?:betales\s+til|modtager|kreditor|betalingsmodtager|leverandør|sælger|udsteder|payee|pay\s+to|seller|from|fra)\s*:\s*([^\n]{2,80})/iu;
const COMPANY = /(?:^|\n)\s*([\p{Lu}][\p{L}\p{N}&.'\- ]{1,50}?\s(?:A\/S|ApS|I\/S|K\/S|P\/S|IVS|a\.m\.b\.a\.|Ltd\.?|Inc\.?|GmbH|AB|AS))(?=[\s,]|$)/mu;

export function isBill(text: string): boolean {
  const head = text.slice(0, 6000);
  return BILL.test(head) && DUE.test(head) && !NOT_A_BILL.test(head);
}

/** Who to pay: labelled, the letterhead's company, the email's sender. */
export function payeeOf(text: string, input: Pick<DetectInput, "email">): Party | null {
  const head = text.slice(0, 4000);
  const p = PAYEE.exec(head);
  if (p) {
    const name = p[1].replace(/\s+/g, " ").replace(/[,;].*$/, "").replace(/\s*<[^>]*>/, "").trim();
    if (name && !/@/.test(name) && !/^\d/.test(name)) return { name, type: "organization" };
  }
  const c = COMPANY.exec(head);
  if (c) return { name: c[1].replace(/\s+/g, " ").trim(), type: "organization" };
  const from = input.email?.from;
  if (from) return { name: from.name || from.email, type: "organization", email: from.email };
  return null;
}

/** "Fakturanr. 10234" / "Invoice no. 4471": what the bill is, for the label. */
function billSubject(text: string, locale: "en" | "da"): string | null {
  const m = /(?:fakturanr\.?|fakturanummer|faktura\s+nr\.?|invoice\s+(?:no\.?|number|#))\s*:?\s*([A-Z0-9][\w-]{1,20})/iu.exec(text);
  if (m) return locale === "da" ? `faktura ${m[1]}` : `invoice ${m[1]}`;
  return null;
}

export function invoiceCandidates(input: DetectInput): Candidate[] {
  if (input.sourceKind === "chat") return [];
  const full = input.segments.map((s) => s.text).join("\n\n");
  if (!isBill(full)) return [];
  const anchor = anchorOf(input.docDate, input.now);
  // The due date: the first date after a due-date label (same line, or the next).
  let due: { date: ReturnType<typeof datesIn>[number]; quote: string; page?: number } | null = null;
  for (const seg of input.segments) {
    const re = new RegExp(DUE.source, DUE.flags.includes("g") ? DUE.flags : DUE.flags + "g");
    for (let m = re.exec(seg.text); m && !due; m = re.exec(seg.text)) {
      const after = seg.text.slice(m.index, m.index + m[0].length + 80);
      const lineEnd = after.indexOf("\n", m[0].length + 1);
      const window = lineEnd > 0 && after.slice(m[0].length, lineEnd).trim() ? after.slice(0, lineEnd) : after;
      const d = datesIn(window, anchor)[0];
      if (!d) continue;
      const quote = window.slice(0, d.index + d.text.length).replace(/^\s+/, "");
      due = { date: d, quote: quote.length < 20 ? sentenceAt(seg.text, m.index, quote.length) : quote, ...(seg.page ? { page: seg.page } : {}) };
    }
    if (due) break;
  }
  if (!due) return [];
  // The amount: labelled as the total, the biggest such one (a total line beats VAT and sub-lines).
  let amount: { value: number; currency: string } | null = null;
  const tre = new RegExp(TOTAL.source, TOTAL.flags.includes("g") ? TOTAL.flags : TOTAL.flags + "g");
  let best = -1;
  for (let m = tre.exec(full); m; m = tre.exec(full)) {
    const a = amountsIn(full.slice(m.index + m[0].length, m.index + m[0].length + 50).split("\n").slice(0, 2).join(" "))[0];
    if (!a) continue;
    const strong = /at\s+betale|til\s+betaling|i\s+alt|due|total/i.test(m[0]) ? 1 : 0;
    const score = strong * 1e9 + a.value;
    if (score > best) { best = score; amount = { value: a.value, currency: a.currency }; }
  }
  const day = { year: due.date.year, month: due.date.month, day: due.date.day };
  return [{
    detector: "invoice", kind: "payment", direction: "owe", dueAt: dueIso(day), dueDay: dayKey(day), dueKind: "deadline",
    amount, counterparty: payeeOf(full, input), subject: billSubject(full, input.locale), owner: { by: "viewer" },
    consequence: null, quote: due.quote.trim(), ...(due.page ? { page: due.page } : {}), confidence: amount ? 0.85 : 0.7,
  }];
}
