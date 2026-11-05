/**
 * Sentences for the per-sentence tier of live highlights (pure). The composer splits what is being written into
 * sentences and lines, keys each by a hash of its text, and sends only sentences it hasn't read before. Results are
 * stored relative to the sentence, so they follow it when text around it moves.
 */

export type Sentence = { key: string; text: string; start: number; end: number; /** ends in . ! ? … or a line break */ complete: boolean };

/** Abbreviations after which a full stop doesn't end the sentence, even before a capital letter. */
const ABBREV = new Set(["dr", "mr", "mrs", "ms", "prof", "st", "hr", "fr", "frk", "fru", "jr", "sr", "nr", "no", "vs", "ca", "bl.a", "f.eks", "fx", "e.g", "i.e", "etc", "mht", "jf", "osv", "evt", "inkl", "ekskl", "tlf", "kl"]);
const MAX = 500;

/** 53-bit string hash (cyrb53), as base36. */
export function hash53(s: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** The key of a sentence: its text with whitespace collapsed. */
export const sentenceKey = (text: string) => hash53(text.replace(/\s+/g, " ").trim());

function endsSentence(text: string, i: number): boolean {
  const c = text[i];
  if (c === "\n") return true;
  if (c === "!" || c === "?" || c === "…") return i + 1 >= text.length || /[\s"”')\]]/.test(text[i + 1]);
  if (c !== ".") return false;
  // "...": one end, at the last dot.
  if (text[i + 1] === ".") return false;
  if (i + 1 < text.length && !/[\s"”')\]]/.test(text[i + 1])) return false; // 3.5, example.com, f.eks
  // The word before: an abbreviation or a number ("12. marts", "kl. 14") doesn't end a sentence unless a capital follows.
  const before = /([\p{L}\p{N}.]+)$/u.exec(text.slice(Math.max(0, i - 12), i))?.[1]?.toLowerCase() ?? "";
  const next = /\S/u.exec(text.slice(i + 1));
  const nextChar = next ? next[0] : "";
  if (ABBREV.has(before)) return false;
  // At the very end ("12.") it may still become "12. marts": not complete yet (the idle timer covers it).
  if (/^\d+$/.test(before)) return !!nextChar && /\p{Lu}/u.test(nextChar);
  return true;
}

/** Split text into trimmed sentences with their offsets. A line break always ends one; very long runs are cut. */
export function splitSentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  let from = 0;
  const push = (end: number, complete: boolean) => {
    let s = from, e = end;
    while (s < e && /\s/.test(text[s])) s++;
    while (e > s && /\s/.test(text[e - 1])) e--;
    if (e > s) {
      const t = text.slice(s, e);
      out.push({ key: sentenceKey(t), text: t, start: s, end: e, complete });
    }
  };
  for (let i = 0; i < text.length; i++) {
    if (endsSentence(text, i)) {
      push(i + 1, true);
      from = i + 1;
    } else if (i - from >= MAX && /\s/.test(text[i])) {
      push(i, true);
      from = i;
    }
  }
  if (from < text.length) push(text.length, false);
  return out;
}

/** The first index where two texts differ (the edit point, for "did they just finish this sentence?"). */
export function firstDiff(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

/** Small LRU map (insertion order = recency). */
export class Lru<K, V> {
  private m = new Map<K, V>();
  constructor(private max: number) {}
  get(k: K): V | undefined {
    const v = this.m.get(k);
    if (v !== undefined) { this.m.delete(k); this.m.set(k, v); }
    return v;
  }
  has(k: K) { return this.m.has(k); }
  set(k: K, v: V) {
    this.m.delete(k);
    this.m.set(k, v);
    while (this.m.size > this.max) this.m.delete(this.m.keys().next().value as K);
    return this;
  }
  delete(k: K) { return this.m.delete(k); }
  get size() { return this.m.size; }
}
