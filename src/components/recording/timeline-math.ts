/**
 * The player's arithmetic, pure (tested): which word is being said at a moment (the "finger"), which line, the
 * clock, search hits, and splitting text into sentences for reading aloud. Times are ms on the recording's time line.
 */
export type Word = { a: number; b: number; w: string; line: number };
export type Line = { a: number; b: number; speaker: string | null; first: number; last: number; text: string };

/**
 * The word at `ms`: the last word that has started. Between two words the finger stays on the one just said; before
 * the first word, -1. Binary search, so it is cheap on every animation frame.
 */
export function wordAt(words: Pick<Word, "a">[], ms: number): number {
  let lo = 0, hi = words.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].a <= ms) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** The line at `ms` (the last one that has started), or -1. */
export function lineAt(lines: Pick<Line, "a">[], ms: number): number {
  return wordAt(lines, ms);
}

/** How far through its word the moment is (0–1), for a finger that glides instead of jumping. */
export function progressInWord(w: Pick<Word, "a" | "b"> | undefined, ms: number): number {
  if (!w || w.b <= w.a) return 1;
  return Math.min(1, Math.max(0, (ms - w.a) / (w.b - w.a)));
}

/** 0:07, 12:34, 1:02:03 */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

const fold = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Lines whose words (or speaker) hold every word of the query, in order. */
export function searchLines(lines: Pick<Line, "text" | "speaker">[], query: string): number[] {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const out: number[] = [];
  lines.forEach((l, i) => {
    const hay = fold(`${l.speaker ?? ""} ${l.text}`);
    if (terms.every((t) => hay.includes(t))) out.push(i);
  });
  return out;
}

/** Does this word match one of the query's terms (for marking hits inside a line)? */
export function wordMatches(word: string, query: string): boolean {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  const w = fold(word).replace(/[^\p{L}\p{N}]/gu, "");
  return !!w && terms.some((t) => w.includes(t.replace(/[^\p{L}\p{N}]/gu, "")));
}

/** A start moment from a link: `#t=83`, `?t=83`, `t=1:23`, or `time=83000` (ms, as a citation's locator). */
export function startFromUrl(search: string, hash: string): number | null {
  const read = (v: string | null, ms = false): number | null => {
    if (!v) return null;
    if (/^\d+(:\d{1,2}){1,2}$/.test(v)) return v.split(":").reduce((a, p) => a * 60 + Number(p), 0) * 1000;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? (ms ? n : n * 1000) : null;
  };
  const h = new URLSearchParams(hash.replace(/^#/, ""));
  const q = new URLSearchParams(search.replace(/^\?/, ""));
  return read(h.get("t")) ?? read(q.get("t")) ?? read(h.get("time"), true) ?? read(q.get("time"), true);
}

export type Sentence = { text: string; start: number; end: number };

/** Split text into sentences (for reading aloud), keeping each one's character range in the text. */
export function sentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  const re = /[^.!?…\n]+(?:[.!?…]+["'”’)\]]*|\n+|$)/g;
  for (const m of text.matchAll(re)) {
    const raw = m[0];
    const lead = raw.length - raw.trimStart().length;
    const t = raw.trim();
    if (!t) continue;
    const start = (m.index ?? 0) + lead;
    out.push({ text: t, start, end: start + t.length });
  }
  return out;
}

/** Words of a sentence with their character ranges (for the finger while it is read aloud). */
export function wordsOf(text: string, offset = 0): { start: number; end: number }[] {
  return [...text.matchAll(/\S+/g)].map((m) => ({ start: offset + (m.index ?? 0), end: offset + (m.index ?? 0) + m[0].length }));
}

/** While a sentence is read, which of its words is being said: by elapsed share of its length (sentence-level timing). */
export function wordInSentence(words: { start: number; end: number }[], elapsed: number, duration: number): number {
  if (!words.length) return -1;
  if (!(duration > 0)) return 0;
  const total = words.reduce((t, w) => t + (w.end - w.start) + 1, 0);
  const at = Math.min(1, Math.max(0, elapsed / duration)) * total;
  let acc = 0;
  for (let i = 0; i < words.length; i++) {
    acc += words[i].end - words[i].start + 1;
    if (at < acc) return i;
  }
  return words.length - 1;
}

/** Back and forward by 15 s, never past either end. */
export function skip(ms: number, by: number, duration: number): number {
  return Math.min(Math.max(0, ms + by), Math.max(0, duration));
}

export const SPEEDS = [1, 1.25, 1.5, 2] as const;

export function nextSpeed(cur: number, dir: 1 | -1): number {
  const i = SPEEDS.indexOf(cur as (typeof SPEEDS)[number]);
  const j = Math.min(SPEEDS.length - 1, Math.max(0, (i < 0 ? 0 : i) + dir));
  return SPEEDS[j];
}
