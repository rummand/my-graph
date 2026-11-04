/**
 * Text helpers shared by corpus reading and compliance checks (pure, unit-tested): finding an exact passage in a text
 * even when the model changed spacing, case or quote marks, splitting text into paragraphs with their offsets, and a
 * stable hash for caching.
 */
/** A 128-bit hash (cyrb128) as hex: no node:crypto, so the browser and the server share it. Not for secrets. */
export function hashText(...parts: string[]): string {
  const str = parts.join("\u0000");
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4; h2 ^= h1; h3 ^= h1; h4 ^= h1;
  return [h1, h2, h3, h4].map((h) => (h >>> 0).toString(16).padStart(8, "0")).join("");
}

/** Lowercase, one kind of quote and dash, single spaces: what a model "quoting exactly" usually still gets right. */
function fold(ch: string): string {
  if (/[‘’‚‛`´]/.test(ch)) return "'";
  if (/[“”„‟«»]/.test(ch)) return "\"";
  if (/[‐-―−]/.test(ch)) return "-";
  if (/\s/.test(ch)) return " ";
  return ch.toLowerCase();
}

/** The folded text plus, for every folded character, where it came from in the original. */
function folded(s: string): { text: string; map: number[] } {
  let text = "";
  const map: number[] = [];
  let lastSpace = true;
  for (let i = 0; i < s.length; i++) {
    const c = fold(s[i]);
    if (c === " ") {
      if (lastSpace) continue;
      lastSpace = true;
    } else lastSpace = false;
    text += c;
    map.push(i);
  }
  if (text.endsWith(" ")) { text = text.slice(0, -1); map.pop(); }
  return { text, map };
}

/**
 * Where `needle` sits in `hay`: exact first, then ignoring case, spacing and quote styles, then (for long needles) the
 * longest leading part of at least 24 characters that matches. Null when it isn't there: a quote that isn't in the
 * source is never trusted.
 */
export function locate(hay: string, needle: string, opts: { allowPrefix?: boolean } = {}): { start: number; end: number } | null {
  const n = needle.trim().replace(/^["'“”„«»]+|["'“”„«»]+$/g, "").trim();
  if (!n) return null;
  const exact = hay.indexOf(n);
  if (exact >= 0) return { start: exact, end: exact + n.length };
  const H = folded(hay);
  const N = folded(n).text;
  if (!N) return null;
  const at = H.text.indexOf(N);
  if (at >= 0) return { start: H.map[at], end: H.map[at + N.length - 1] + 1 };
  if (opts.allowPrefix && N.length >= 40) {
    // The model sometimes runs on past the passage: keep the longest start that is really there.
    for (let len = N.length - 1; len >= 24; len -= Math.max(1, Math.floor(len / 12))) {
      const p = H.text.indexOf(N.slice(0, len));
      if (p >= 0) return { start: H.map[p], end: H.map[p + len - 1] + 1 };
    }
  }
  return null;
}

export type Paragraph = { index: number; start: number; end: number; text: string; key: string };

/**
 * Paragraphs of a text with their offsets: split on blank lines, or on single newlines when the text has none (chat
 * answers, op sentences). Empty ones are skipped; the key is the hash of the paragraph's own words.
 */
export function splitParagraphs(text: string): Paragraph[] {
  const out: Paragraph[] = [];
  const sep = /\n\s*\n/.test(text) ? /\n\s*\n/g : /\n/g;
  let last = 0;
  const push = (from: number, to: number) => {
    const raw = text.slice(from, to);
    const lead = raw.length - raw.trimStart().length;
    const body = raw.trim();
    if (!body) return;
    const start = from + lead;
    out.push({ index: out.length, start, end: start + body.length, text: body, key: hashText(body) });
  };
  for (const m of text.matchAll(sep)) {
    push(last, m.index!);
    last = m.index! + m[0].length;
  }
  push(last, text.length);
  return out;
}

/** Words of a text for overlap scores (letters and digits, Danish included, 3+ characters, § kept). */
export function words(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[\p{L}\p{N}§]{3,}|§\s?\d+/gu) ?? []).map((w) => w.replace(/\s/g, "")));
}

/** Jaccard overlap of two texts' words, 0..1. */
export function overlap(a: string, b: string): number {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / (A.size + B.size - both);
}

export function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}
