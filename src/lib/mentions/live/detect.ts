/**
 * Deterministic detectors for live highlights (pure; the composer runs them on every keystroke, the server reuses
 * them in the stream). They find details that need no model: dates and times in English and Danish ("next Friday",
 * "på torsdag", "i morgen", "12. marts", "kl. 14"), emails, phone numbers, links and amounts of money; and names
 * that look new (capitalised words that aren't in the graph), shown as a faint "maybe new" mark, never a proposal.
 */

export type DetailKind = "date" | "time" | "email" | "phone" | "url" | "money" | "maybeNew";
export type Detail = { start: number; end: number; text: string; kind: DetailKind };

const L = "\\p{L}\\p{N}";
const B = `(?<![${L}])`; // word start
const E = `(?![${L}])`; // word end

const MONTHS_EN = "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec";
const MONTHS_DA = "januar|februar|marts|april|maj|juni|juli|august|september|oktober|november|december";
const MONTHS = `${MONTHS_EN}|${MONTHS_DA}`;
const DAYS_EN = "monday|tuesday|wednesday|thursday|friday|saturday|sunday";
const DAYS_DA = "mandag|tirsdag|onsdag|torsdag|fredag|lørdag|søndag";
const DAYS = `${DAYS_EN}|${DAYS_DA}`;
const PARTS_DA = "morgen|formiddag|eftermiddag|aften|nat";

const DATE_RES: RegExp[] = [
  // ISO and numeric dates: 2026-03-12, 12/3, 12/3/2026, 12.3.2026
  new RegExp(`${B}\\d{4}-\\d{2}-\\d{2}${E}`, "gu"),
  new RegExp(`${B}\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?${E}`, "gu"),
  new RegExp(`${B}\\d{1,2}\\.\\d{1,2}\\.\\d{4}${E}`, "gu"),
  // 12 March, 12. marts, 12th of March 2026, den 12. marts
  new RegExp(`${B}(?:den\\s+)?\\d{1,2}(?:\\.|st|nd|rd|th)?\\s+(?:of\\s+)?(?:${MONTHS})${E}(?:\\s+\\d{4}${E})?`, "giu"),
  // March 12, March 12th, 2026
  new RegExp(`${B}(?:${MONTHS_EN})\\s+\\d{1,2}(?:st|nd|rd|th)?${E}(?:,?\\s+\\d{4}${E})?`, "giu"),
  // English relative days
  new RegExp(`${B}(?:the\\s+day\\s+after\\s+tomorrow|today|tonight|tomorrow|yesterday|this\\s+(?:morning|afternoon|evening|weekend))${E}`, "giu"),
  new RegExp(`${B}(?:next|this|last|coming|on)\\s+(?:${DAYS_EN}|week|weekend|month|year)${E}`, "giu"),
  // Danish relative days: i dag, i morgen, i overmorgen, i går, i aften, i weekenden, på torsdag, næste uge, i næste uge
  new RegExp(`${B}i\\s+(?:dag|morgen(?:\\s+tidlig)?|overmorgen|går|forgårs|aften|nat|weekenden|eftermiddag)${E}`, "giu"),
  new RegExp(`${B}(?:på|om|i)\\s+(?:${DAYS_DA})(?:\\s+(?:${PARTS_DA}))?${E}`, "giu"),
  new RegExp(`${B}(?:i\\s+)?(?:næste|sidste|denne|kommende)\\s+(?:${DAYS_DA}|uge|weekend|måned|år)${E}`, "giu"),
  // A weekday on its own
  new RegExp(`${B}(?:${DAYS})${E}`, "giu"),
];

const TIME_RES: RegExp[] = [
  new RegExp(`${B}(?:kl\\.?|klokken)\\s*\\d{1,2}(?:[.:]\\d{2})?${E}`, "giu"),
  new RegExp(`${B}(?:at\\s+)?\\d{1,2}:\\d{2}(?:\\s*[ap](?:\\.m\\.|m))?(?![${L}])`, "giu"),
  new RegExp(`${B}\\d{1,2}\\s*[ap](?:\\.m\\.|m)(?![${L}])`, "giu"),
];

const EMAIL_RE = /(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gu;
const URL_RE = /(?<![\w/])(?:https?:\/\/|www\.)[^\s<>"'()]+/giu;
const MONEY_RES: RegExp[] = [
  new RegExp(`(?:${B}(?:kr\\.?|dkk|eur|usd|gbp)\\s?|[€$£]\\s?)\\d[\\d.,]*\\d?${E}`, "giu"),
  new RegExp(`${B}\\d[\\d.,]*\\s?(?:kr(?=\\.|${E})|kroner${E}|dkk${E}|euro${E}|eur${E}|usd${E}|dollars?${E}|pounds?${E}|[€$£])`, "giu"),
];
const PHONE_RES: RegExp[] = [
  /(?<![\d\w+])(?:\+\d{1,3}[\s-]?)?\d{2}[\s-]?\d{2}[\s-]?\d{2}[\s-]?\d{2}(?![\d\w])/gu,
  /(?<![\d\w+])\+\d{1,3}[\s-]?\d[\d\s-]{6,13}\d(?![\d\w])/gu,
];

function collect(text: string, res: RegExp[], kind: DetailKind, out: Detail[]) {
  for (const re of res) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      let s = m.index ?? 0;
      let t = m[0];
      if (kind === "url") t = t.replace(/[.,;:!?]+$/, "");
      if (kind === "time" && /^at\s+/i.test(t)) { const cut = t.match(/^at\s+/i)![0].length; s += cut; t = t.slice(cut); }
      if (t) out.push({ start: s, end: s + t.length, text: t, kind });
    }
  }
}

/** Keep spans in the order given (priority), dropping any that overlap one already kept. */
function claim<T extends { start: number; end: number }>(items: T[], taken: { start: number; end: number }[] = []): T[] {
  const kept: T[] = [];
  const all = [...taken];
  for (const it of items) {
    if (all.some((x) => it.start < x.end && it.end > x.start)) continue;
    kept.push(it);
    all.push(it);
  }
  return kept;
}

/** Dates, times, emails, phone numbers, links and money in the text: non-overlapping, in text order. */
export function detectDetails(text: string): Detail[] {
  if (!text) return [];
  const byKind: Detail[][] = [[], [], [], [], [], []];
  collect(text, [URL_RE], "url", byKind[0]);
  collect(text, [EMAIL_RE], "email", byKind[1]);
  collect(text, MONEY_RES, "money", byKind[2]);
  collect(text, DATE_RES, "date", byKind[3]);
  collect(text, TIME_RES, "time", byKind[4]);
  collect(text, PHONE_RES, "phone", byKind[5]);
  // Longest first inside each kind, so "next Friday" beats "Friday".
  const ordered = byKind.flatMap((xs) => xs.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start));
  return claim(ordered).sort((a, b) => a.start - b.start);
}

/* ── Names that look new ───────────────────────────────────────────────────────────────────────────────── */

/** Capitalised words that aren't names: pronouns, function words, days, months, greetings (English and Danish). */
const NOT_NAMES = new Set([
  "i", "i'm", "i'll", "i've", "i'd", "the", "a", "an", "my", "our", "we", "he", "she", "they", "it", "you", "your", "his", "her", "their", "this", "that",
  "these", "those", "and", "or", "but", "so", "if", "when", "then", "there", "here", "what", "who", "where", "why", "how", "can", "could", "would",
  "should", "will", "please", "thanks", "hi", "hello", "hey", "yes", "no", "ok", "okay", "also", "today", "tomorrow", "yesterday", "tonight", "next", "last",
  "jeg", "du", "han", "hun", "vi", "de", "den", "det", "der", "en", "et", "og", "men", "så", "hvis", "når", "hvad", "hvem", "hvor", "hvorfor", "hvordan",
  "min", "mit", "mine", "vores", "jeres", "hans", "hendes", "deres", "kan", "skal", "vil", "må", "hej", "tak", "ja", "nej", "også", "i dag", "måske",
  ...DAYS.split("|"), ...MONTHS.split("|"),
]);
const TITLES = new Set(["dr", "mr", "mrs", "ms", "prof", "hr", "fru", "frk"]);
const PARTICLES = new Set(["van", "von", "de", "der", "den", "af", "la", "le", "du", "di", "da", "del", "of"]);

const TOKEN_RE = /[\p{L}\p{N}][\p{L}\p{N}'’&-]*\.?/gu;
const isCap = (w: string) => /^\p{Lu}/u.test(w);
const bare = (w: string) => w.replace(/['’]s$/u, "").replace(/\.$/, "").toLowerCase();

/** Sentence-initial: nothing before but whitespace, or an end of sentence / line / quote. */
function sentenceStart(text: string, i: number): boolean {
  let k = i - 1;
  while (k >= 0 && /[ \t"“”'«»(]/u.test(text[k])) k--;
  return k < 0 || /[.!?…:\n]/u.test(text[k]);
}

/**
 * Runs of capitalised words that look like a new name ("Peter Andersen", "Novo Nordisk", "Rema 1000"). A single
 * word counts only away from the start of a sentence. Anything overlapping `taken` (known names, details) is skipped.
 */
export function maybeNewNames(text: string, taken: { start: number; end: number }[] = []): Detail[] {
  type Tok = { w: string; start: number; end: number };
  const runs: Tok[][] = [];
  let run: Tok[] = [];
  const flush = () => {
    while (run.length && PARTICLES.has(run[run.length - 1].w.toLowerCase())) run.pop();
    if (run.length) runs.push(run);
    run = [];
  };
  for (const m of text.matchAll(TOKEN_RE)) {
    const t: Tok = { w: m[0], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length };
    const last = run[run.length - 1];
    const adjacent = !!last && text.slice(last.end, t.start) === " " && !/['’]s$/u.test(last.w)
      && (!last.w.endsWith(".") || TITLES.has(bare(last.w)));
    if (isCap(t.w)) {
      if (!adjacent) flush();
      run.push(t);
    } else if (adjacent && (/^\d+\.?$/.test(t.w) || PARTICLES.has(t.w.toLowerCase()))) {
      run.push(t);
    } else flush();
  }
  flush();

  const out: Detail[] = [];
  for (const r of runs) {
    let toks = r;
    while (toks.length && NOT_NAMES.has(bare(toks[0].w))) toks = toks.slice(1);
    while (toks.length && NOT_NAMES.has(bare(toks[toks.length - 1].w))) toks = toks.slice(0, -1);
    if (!toks.length || (toks.length === 1 && TITLES.has(bare(toks[0].w)))) continue;
    const start = toks[0].start;
    const surface = text.slice(start, toks[toks.length - 1].end).replace(/['’]s$/u, "").replace(/\.$/, "");
    if (toks.length === 1 && (sentenceStart(text, start) || bare(toks[0].w).length < 3 || /^\d/.test(toks[0].w))) continue;
    out.push({ start, end: start + surface.length, text: surface, kind: "maybeNew" });
  }
  return claim(out, taken);
}
