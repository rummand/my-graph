/**
 * Reading small facts out of text without a model (pure): amounts ("1.250,00 kr", "DKK 1,250.00"), periods
 * ("3 måneders varsel", "4 weeks to complain") and due dates ("senest 20. november", "by 20 November 2026"), plus the
 * normalising helpers the checks share. Danish and English. Every hit keeps its exact quote and offset, so a flag or a
 * proposal can show the words it rests on.
 */

/** Lower case, Danish letters kept, other accents folded, whitespace collapsed. */
export function norm(s: string): string {
  return s.toLowerCase()
    .replace(/[à-ä]/g, (c) => (c === "å" ? c : "a")).replace(/[è-ë]/g, "e").replace(/[ì-ï]/g, "i")
    .replace(/[ò-ö]/g, (c) => (c === "ø" ? c : "o")).replace(/[ù-ü]/g, "u")
    .replace(/\s+/g, " ").trim();
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Does `text` (already normalised) contain `name` as whole words? Names under 3 letters never match. */
export function hasName(text: string, name: string): boolean {
  const n = norm(name).replace(/[^\p{L}\p{N} &.-]/gu, " ").replace(/\s+/g, " ").trim();
  if (n.length < 3) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(n)}($|[^\\p{L}\\p{N}])`, "u").test(text);
}

/** A name and its everyday forms: without the company suffix ("Vejle Vand A/S" → "Vejle Vand"). */
export function nameVariants(name: string): string[] {
  const n = name.trim();
  const bare = n.replace(/[,\s]+(a\/s|aps|i\/s|k\/s|p\/s|ivs|amba|a\.m\.b\.a\.|ltd\.?|limited|inc\.?|llc|gmbh|ab|as|asa|oy|bv|plc|co\.?)$/i, "").trim();
  return bare && bare !== n && bare.length >= 3 ? [n, bare] : [n];
}

/** A short quote around [start, end): whole words, at most ~`max` characters. */
export function quoteAround(text: string, start: number, end: number, max = 160): string {
  const pad = Math.max(0, Math.floor((max - (end - start)) / 2));
  let a = Math.max(0, start - pad), b = Math.min(text.length, end + pad);
  if (a > 0) { const sp = text.indexOf(" ", a); if (sp >= 0 && sp < start) a = sp + 1; }
  if (b < text.length) { const sp = text.lastIndexOf(" ", b); if (sp > end) b = sp; }
  return `${a > 0 ? "…" : ""}${text.slice(a, b).replace(/\s+/g, " ").trim()}${b < text.length ? "…" : ""}`;
}

/* ── Amounts ─────────────────────────────────────────────────────────────────────────────────────────── */

export type Amount = { value: number; currency: string; quote: string; index: number };

const CUR_BEFORE = /(kr\.?|dkk|eur|€|usd|\$|sek|nok)\s?(\d{1,3}(?:[.\s ]\d{3})+(?:,\d{1,2})?|\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?![\d])/gi;
const CUR_AFTER = /(?<![\d.,])(\d{1,3}(?:[.\s ]\d{3})+(?:,\d{1,2}|,-)?|\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:[.,]\d{1,2}|,-)?)\s?(kr\.?|kroner|dkk|eur|euro|€|usd|sek|nok|,-)(?![\p{L}])/giu;

function currencyOf(s: string): string {
  const c = s.toLowerCase();
  if (c.startsWith("eur") || c === "€") return "EUR";
  if (c === "usd" || c === "$") return "USD";
  if (c === "sek") return "SEK";
  if (c === "nok") return "NOK";
  return "DKK";
}

/** "1.250,00" → 1250, "1,250.00" → 1250, "1250" → 1250, "12,5" → 12.5, "1.250,-" → 1250. */
export function parseNumber(raw: string): number | null {
  let s = raw.replace(/[\s ]/g, "").replace(/,-$/, "");
  const lastDot = s.lastIndexOf("."), lastComma = s.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = lastDot > lastComma ? "." : ",";
    const thou = dec === "." ? "," : ".";
    s = s.split(thou).join("").replace(dec, ".");
  } else if (lastComma >= 0) {
    const tail = s.length - lastComma - 1;
    s = tail === 3 && /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, "") : s.replace(",", ".");
  } else if (lastDot >= 0) {
    const tail = s.length - lastDot - 1;
    if (tail === 3 && /^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Every amount with a currency in the text. */
export function findAmounts(text: string): Amount[] {
  const out: Amount[] = [];
  const seen = new Set<number>();
  for (const re of [CUR_BEFORE, CUR_AFTER]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const before = re === CUR_BEFORE;
      const num = before ? m[2] : m[1];
      const cur = before ? m[1] : m[2];
      const value = parseNumber(num);
      if (value === null || value <= 0) continue;
      const index = m.index ?? 0;
      // The same figure caught by both patterns ("kr. 1.250,00 kr") counts once.
      const numIndex = index + m[0].indexOf(num);
      if (seen.has(numIndex)) continue;
      seen.add(numIndex);
      out.push({ value, currency: currencyOf(cur), quote: m[0].trim(), index });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

/** Same amount: equal to the øre, or within 0.5 % for large sums written rounded. */
export function sameAmount(a: { value: number; currency?: string | null }, b: { value: number; currency?: string | null }): boolean {
  if (a.currency && b.currency && a.currency.toUpperCase() !== b.currency.toUpperCase()) return false;
  const diff = Math.abs(a.value - b.value);
  return diff < 0.005 || (diff <= Math.max(a.value, b.value) * 0.005 && Math.max(a.value, b.value) >= 1000);
}

/* ── Periods ─────────────────────────────────────────────────────────────────────────────────────────── */

export type PeriodTopic = "notice" | "complaint" | "reply" | "other";
export type Period = { days: number; topic: PeriodTopic; quote: string; index: number };

const WORD_NUM: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, eight: 8, twelve: 12, fourteen: 14,
  en: 1, et: 1, een: 1, to: 2, tre: 3, fire: 4, fem: 5, seks: 6, otte: 8, tolv: 12, fjorten: 14,
};
const PERIOD_RE = /(?<![\p{L}\d])(\d{1,3}|one|two|three|four|five|six|eight|twelve|fourteen|en|et|to|tre|fire|fem|seks|otte|tolv|fjorten)\s?(?:-\s?)?(dage|dags|dag|days?|uger|ugers|uges|uge|weeks?|måneder|måneders|måneds|måned|maaneder|maaneders|mdr\.?|months?|års|år|years?)(?![\p{L}])/giu;

function unitDays(u: string): number {
  const s = u.toLowerCase();
  if (s.startsWith("dag") || s.startsWith("day")) return 1;
  if (s.startsWith("uge") || s.startsWith("week")) return 7;
  if (s.startsWith("m") ) return 30;
  return 365;
}

const TOPIC_WORDS: [PeriodTopic, RegExp][] = [
  ["complaint", /klage|klagefrist|complain|appeal|anke|indsigelse|object(ion)?|partshøring/i],
  ["notice", /opsig|varsel|notice|terminat|cancel|udtræd|fraflyt|move out/i],
  ["reply", /svar|reply|respond|answer|besvar/i],
];

/** Periods ("3 måneders varsel", "4 weeks to complain") with what they are about, read from the words around them. */
export function findPeriods(text: string, windowChars = 70): Period[] {
  const out: Period[] = [];
  PERIOD_RE.lastIndex = 0;
  for (const m of text.matchAll(PERIOD_RE)) {
    const n = /^\d+$/.test(m[1]) ? Number(m[1]) : WORD_NUM[m[1].toLowerCase()];
    if (!n || n > 400) continue;
    const index = m.index ?? 0;
    // "en" / "et" are also the Danish "a": only "en måneds varsel" (genitive) reads as a period, not "i en måned".
    if (/^(en|et)$/i.test(m[1]) && !/s$/i.test(m[2])) continue;
    const around = text.slice(Math.max(0, index - windowChars), Math.min(text.length, index + m[0].length + windowChars));
    const topic = TOPIC_WORDS.find(([, re]) => re.test(around))?.[0] ?? "other";
    out.push({ days: n * unitDays(m[2]), topic, quote: quoteAround(text, index, index + m[0].length, 140), index });
  }
  return out;
}

/** Two periods are the same when they are within a couple of days (a month is 28–31 days; "4 weeks" ≈ "1 month" is not). */
export function samePeriod(a: number, b: number): boolean {
  return Math.abs(a - b) <= 2;
}

/* ── Dates ───────────────────────────────────────────────────────────────────────────────────────────── */

export type DueDate = { day: string; quote: string; index: number; moved: boolean };

const MONTHS: Record<string, number> = {
  januar: 1, january: 1, jan: 1, februar: 2, february: 2, feb: 2, marts: 3, march: 3, mar: 3, april: 4, apr: 4, maj: 5, may: 5,
  juni: 6, june: 6, jun: 6, juli: 7, july: 7, jul: 7, august: 8, aug: 8, september: 9, sep: 9, sept: 9, oktober: 10, october: 10, okt: 10, oct: 10,
  november: 11, nov: 11, december: 12, dec: 12,
};
const MONTH_ALT = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
const DATE_RES: { re: RegExp; parse: (m: RegExpMatchArray) => [number, number, number | null] }[] = [
  { re: /(\d{4})-(\d{2})-(\d{2})/g, parse: (m) => [Number(m[3]), Number(m[2]), Number(m[1])] },
  { re: /(?<!\d)(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})(?!\d)/g, parse: (m) => [Number(m[1]), Number(m[2]), m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])] },
  { re: new RegExp(`(?<!\\d)(\\d{1,2})\\.?\\s?(?:of\\s)?(${MONTH_ALT})\\.?(?:\\s(\\d{4}))?(?![\\p{L}])`, "giu"), parse: (m) => [Number(m[1]), MONTHS[m[2].toLowerCase()], m[3] ? Number(m[3]) : null] },
  { re: new RegExp(`(?<![\\p{L}])(${MONTH_ALT})\\.?\\s(\\d{1,2})(?:st|nd|rd|th)?,?(?:\\s(\\d{4}))?(?!\\d)`, "giu"), parse: (m) => [Number(m[2]), MONTHS[m[1].toLowerCase()], m[3] ? Number(m[3]) : null] },
];
const DUE_WORDS = /(senest|inden|før|frist|betalingsfrist|svarfrist|klagefrist|forfald|sidste (frist|dag)|due|deadline|no later than|not later than|before|by|until|indtil|last day)\W{0,3}(?:\p{L}+\W{1,3}){0,3}$/iu;
const MOVED_WORDS = /(ny frist|nye frist|flyttet|rykket|udsat|ændret|i stedet|forlænget|moved|postponed|rescheduled|changed|instead|extended|new deadline|now due)/i;

const pad2 = (n: number) => String(n).padStart(2, "0");

/** A calendar day without a year: the occurrence nearest to `ref` (within half a year either side). */
function withYear(d: number, mo: number, y: number | null, ref: Date): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  let year = y ?? ref.getUTCFullYear();
  if (y === null) {
    const t = Date.UTC(year, mo - 1, d), r = ref.getTime();
    if (t - r > 183 * 86_400_000) year -= 1; else if (r - t > 183 * 86_400_000) year += 1;
  }
  const dt = new Date(Date.UTC(year, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) return null;
  return `${year}-${pad2(mo)}-${pad2(d)}`;
}

/** Due dates: a date with a deadline word just before it ("senest 20. november", "by 20 November 2026"). */
export function findDueDates(text: string, ref: Date): DueDate[] {
  const out: DueDate[] = [];
  const taken = new Set<number>();
  for (const { re, parse } of DATE_RES) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const index = m.index ?? 0;
      if ([...taken].some((t) => Math.abs(t - index) < 4)) continue;
      const before = text.slice(Math.max(0, index - 40), index);
      if (!DUE_WORDS.test(before)) continue;
      const [d, mo, y] = parse(m);
      const day = withYear(d, mo, y, ref);
      if (!day) continue;
      taken.add(index);
      const ctx = text.slice(Math.max(0, index - 120), Math.min(text.length, index + m[0].length + 60));
      out.push({ day, quote: quoteAround(text, Math.max(0, index - before.length + before.search(/\S/)), index + m[0].length, 160), index, moved: MOVED_WORDS.test(ctx) });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

/** The ISO day (YYYY-MM-DD) of an instant in a time zone. */
export function dayIn(at: Date, tz: string): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")}`;
}
