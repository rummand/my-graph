/**
 * Insurance policies, leases, subscriptions and other agreements (pure). Two things matter in them:
 *
 *   renewal   when it renews or runs out ("Hovedforfald: 1. januar", "fornyes den 1.1.2027", "Renewal date",
 *             "udløber", "expires") — recurring yearly when it is a main due date / renewal
 *   notice    the last day to cancel before that: renewal − notice period ("opsiges med 3 måneders varsel",
 *             "opsigelsesvarsel: løbende måned + 1 måned", "notice period of 30 days")
 *
 * Notice math: with a plain period the notice must be in the day before (renewal − period); with "løbende måned"
 * (to the end of a month) it must be in by the end of the month before that.
 */
import { dkRe } from "@/lib/importers/dk/authorities";
import { amountsIn, sayAmount } from "./amount";
import { sentenceAt, type Candidate, type DetectInput, type Party } from "./candidate";
import { addDays, addMonths, addPeriod, anchorOf, compareDays, copenhagenDay, datesIn, dayKey, dueIso, endOfMonth, numberOf, unitOf, type Day, type Unit } from "./when";

const AGREEMENT = dkRe(String.raw`\b(forsikring|police|policenr|policenummer|forsikringsbevis|lejekontrakt|lejeaftale|lejemål|abonnement|medlemskab|kontrakt|aftale(?:n)?\s+(?:om|fornyes|løber)|insurance|policy\s+(?:no|number|schedule)|lease|tenancy|subscription|membership|agreement)`, "i");
const RENEWAL = dkRe(String.raw`\b(hovedforfald(?:sdato|sdag)?|fornyes(?:\s+automatisk)?(?:\s+(?:den|pr\.?))?|fornyelsesdato|fornyelse(?:\s+(?:den|pr\.?))?|forlænges(?:\s+automatisk)?(?:\s+(?:den|pr\.?))?|udløber(?:\s+(?:den|pr\.?))?|udløbsdato|gælder\s+(?:til|indtil)|ophører(?:\s+den)?|renewal\s+date|renews(?:\s+(?:on|automatically\s+on))?|expires(?:\s+on)?|expiry\s+date|expiration\s+date|valid\s+until|end\s+date)\b`, "i");
const NOTICE_PERIOD = new RegExp(
  String.raw`(?<![\p{L}])(?:(?:opsigelsesvarsel(?:et)?|varsel(?:et)?|opsigelsesfrist(?:en)?|notice\s+period|notice)\s*(?:er|is|of|på|:)?\s*(?:mindst\s+|at\s+least\s+)?(løbende\s+måned\s*\+\s*)?(\d{1,3}|en|et|to|tre|fire|seks|one|two|three|four|six)\s+(dage|dags|uger|ugers|måneder|måneders|måned|days?|weeks?|months?)|(?:med|with|giving)\s+(?:mindst\s+|at\s+least\s+)?(løbende\s+måned\s*\+\s*)?(\d{1,3}|en|et|to|tre|fire|seks|one|two|three|four|six)\s+(dages|ugers|måneders|måneds|days?'?|weeks?'?|months?'?)\s*(?:skriftligt\s+)?(?:varsel|opsigelsesvarsel|notice)|(løbende\s+måned\s*\+\s*)(\d{1,2}|en|et|to|tre)\s+(måneder|måned|months?))`,
  "iu",
);
const RUNNING_MONTH = /løbende\s+måned|end\s+of\s+(?:a|the)\s+(?:calendar\s+)?month|til\s+udgangen\s+af\s+en\s+måned|til\s+en\s+måneds\s+udgang/i;

const INSURERS = ["Tryg", "Topdanmark", "Alm. Brand", "Codan", "If Skadeforsikring", "If", "GF Forsikring", "LB Forsikring", "Gjensidige", "Privatsikring", "Købstædernes Forsikring", "Lærerstandens Brandforsikring", "Runa Forsikring", "Dansk Boligforsikring", "Bauta", "Sygeforsikringen danmark", "PFA", "Danica", "Velliv", "AP Pension", "Popular Pension", "Nykredit Forsikring", "Moderna", "Undo", "Aros Forsikring", "Thisted Forsikring", "Vestjylland Forsikring", "Frida Forsikring"];

export type NoticePeriod = { n: number; unit: Unit; runningMonth: boolean; text: string; index: number };

export function noticePeriodIn(text: string): NoticePeriod | null {
  const m = NOTICE_PERIOD.exec(text);
  if (!m) return null;
  const [runA, nA, uA, runB, nB, uB, runC, nC, uC] = m.slice(1);
  const n = numberOf(nA ?? nB ?? nC);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = unitOf((uA ?? uB ?? uC).replace(/s'?$|'$/, "").replace(/ers$/, "er").replace(/s$/, ""));
  const running = !!(runA ?? runB ?? runC) || RUNNING_MONTH.test(text.slice(m.index, m.index + 160));
  return { n, unit, runningMonth: running, text: m[0], index: m.index };
}

/** The last day notice can be given to stop it renewing on `renewal`. */
export function noticeDeadline(renewal: Day, p: Pick<NoticePeriod, "n" | "unit" | "runningMonth">): Day {
  if (p.runningMonth) {
    // "Løbende måned + n": notice given in a month ends it n months after that month's end, so it must be in by
    // the end of the month n + 1 months before the renewal month (1 Jan, + 1 month → 30 Nov).
    if (p.unit === "month") return endOfMonth(addMonths({ year: renewal.year, month: renewal.month, day: 1 }, -(p.n + 1)));
    const last = addPeriod(addDays(renewal, -1), -p.n, p.unit);
    return endOfMonth(addMonths({ ...last, day: 1 }, -1));
  }
  // A plain period: the renewal day minus the period (3 months before 1 January = 1 October).
  return addPeriod(renewal, -p.n, p.unit);
}

function counterpartyOf(text: string, input: Pick<DetectInput, "email">): Party | null {
  const head = text.slice(0, 5000);
  const labelled = /(?:^|\n)\s*(?:forsikringsselskab|selskab|udlejer|leverandør|forsikringsgiver|insurer|landlord|lessor|provider|company|udbyder)\s*:\s*([^\n]{2,70})/iu.exec(head);
  if (labelled) return { name: labelled[1].replace(/\s+/g, " ").replace(/[,;].*$/, "").trim(), type: "organization" };
  // The company's full name in the letterhead ("Tryg Forsikring A/S") beats a bare brand from the list below.
  const company = /(?:^|\n)\s*([\p{Lu}][\p{L}\p{N}&.'\- ]{1,50}?\s(?:A\/S|ApS|I\/S|K\/S|P\/S|a\.m\.b\.a\.|Ltd\.?|GmbH|AB))(?=[\s,]|$)/mu.exec(head);
  if (company) return { name: company[1].replace(/\s+/g, " ").trim(), type: "organization" };
  for (const name of INSURERS) {
    if (new RegExp(String.raw`(?<![\p{L}])${name.replace(/[.]/g, "\\.").replace(/ /g, "\\s+")}(?![\p{L}])`, "u").test(head)) return { name, type: "organization" };
  }
  if (input.email?.from) return { name: input.email.from.name || input.email.from.email, type: "organization", email: input.email.from.email };
  return null;
}

/** "Bilforsikring", "Indboforsikring", "lejemålet", "car insurance": what the agreement is. */
function agreementSubject(text: string): string | null {
  const head = text.slice(0, 4000);
  const da = /(?<![\p{L}])([\p{L}]{3,}forsikring(?:en)?|lejemål(?:et)?|lejeaftale(?:n)?|abonnement(?:et)?|medlemskab(?:et)?)(?![\p{L}])/iu.exec(head);
  if (da) return da[1].toLowerCase().replace(/(forsikring)en$/u, "$1").replace(/(lejemål|abonnement|medlemskab)et$/u, "$1").replace(/(lejeaftale)n$/u, "$1");
  const en = /\b((?:car|home|house|contents|travel|health|life|pet|motor|accident)\s+insurance|lease|tenancy|subscription|membership)\b/i.exec(head);
  return en ? en[1].toLowerCase() : null;
}

export function contractCandidates(input: DetectInput): Candidate[] {
  if (input.sourceKind === "chat") return [];
  const full = input.segments.map((s) => s.text).join("\n\n");
  const head = full.slice(0, 12000);
  if (!AGREEMENT.test(head)) return [];
  const anchor = anchorOf(input.docDate, input.now);
  const today = copenhagenDay(input.now);
  let renewal: { day: Day; quote: string; page?: number; yearly: boolean; expires: boolean } | null = null;
  for (const seg of input.segments) {
    const re = new RegExp(RENEWAL.source, RENEWAL.flags.includes("g") ? RENEWAL.flags : RENEWAL.flags + "g");
    for (let m = re.exec(seg.text); m && !renewal; m = re.exec(seg.text)) {
      const window = seg.text.slice(m.index, m.index + m[0].length + 60);
      const line = window.split("\n").length > 1 && !window.split("\n")[0].slice(m[0].length).trim() ? window.split("\n").slice(0, 2).join("\n") : window.split("\n")[0];
      const d = datesIn(line, anchor)[0];
      if (!d) continue;
      let day: Day = { year: d.year, month: d.month, day: d.day };
      const lead = m[0].toLowerCase();
      const yearly = /hovedforfald|fornye|forlæng|renew/.test(lead);
      // A main due date in the past is next year's (a policy schedule names the yearly day).
      while (yearly && compareDays(day, today) < 0) day = addMonths(day, 12);
      renewal = { day, quote: line.slice(0, d.index + d.text.length).trim(), ...(seg.page ? { page: seg.page } : {}), yearly, expires: /udløb|ophører|gælder|expir|valid|end\s+date/.test(lead) };
    }
    if (renewal) break;
  }
  if (!renewal) return [];
  const counterparty = counterpartyOf(full, input);
  const subject = agreementSubject(full);
  const premium = /(?:årlig\s+præmie|præmie|pris\s+pr\.?\s+år|årlig\s+pris|annual\s+premium|premium|husleje|monthly\s+rent|rent)\s*:?\s*([^\n]{0,40})/iu.exec(full);
  const amt = premium ? amountsIn(premium[1])[0] : undefined;
  const amount = amt ? { value: amt.value, currency: amt.currency } : null;
  const recurrence = renewal.yearly ? "FREQ=YEARLY" : null;
  const out: Candidate[] = [];
  const consequenceText = (locale: "en" | "da") => (renewal!.yearly
    ? locale === "da" ? `${subject ? subject[0].toUpperCase() + subject.slice(1) : "Aftalen"} fornyes for et år${amount ? ` til ${sayAmount(amount, "da")}` : ""}` : `${subject ? subject[0].toUpperCase() + subject.slice(1) : "The agreement"} renews for a year${amount ? ` at ${sayAmount(amount, "en")}` : ""}`
    : null);
  out.push({
    detector: "contract", kind: "renewal", direction: "owe", dueAt: dueIso(renewal.day), dueDay: dayKey(renewal.day), dueKind: recurrence ? "recurring" : "date",
    recurrence, amount, counterparty, subject, owner: { by: "viewer" }, consequence: null,
    quote: renewal.quote, ...(renewal.page ? { page: renewal.page } : {}), confidence: 0.85,
  });
  // The notice period, in the same agreement.
  for (const seg of input.segments) {
    const p = noticePeriodIn(seg.text);
    if (!p) continue;
    const due = noticeDeadline(renewal.day, p);
    out.push({
      detector: "contract", kind: "notice", flavor: "cancel", direction: "owe", dueAt: dueIso(due), dueDay: dayKey(due), dueKind: recurrence ? "recurring" : "deadline",
      recurrence, amount: null, counterparty, subject, owner: { by: "viewer" }, consequence: consequenceText(input.locale),
      dueWords: p.text.replace(/\s+/g, " ").trim(),
      quote: sentenceAt(seg.text, p.index, p.text.length), ...(seg.page ? { page: seg.page } : {}), confidence: 0.8,
    });
    break;
  }
  return out;
}
