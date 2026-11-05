/**
 * Highlight offsets and snippets. Pure, shared by client and server. Offsets are JavaScript string indexes into the
 * original text: lower-casing is done character by character so "Æble", "TANDLÆGE" and "Øster" keep their positions.
 */
import type { Range } from "./types";

/** Lower-case without changing length (a character whose lower case is longer, like "İ", is kept as it is). */
export function foldCase(s: string): string {
  let out = "";
  for (const ch of s) {
    const l = ch.toLowerCase();
    out += l.length === ch.length ? l : ch;
  }
  return out;
}

const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);

/** Merge overlapping/adjacent ranges, sorted. */
export function mergeRanges(rs: Range[]): Range[] {
  const sorted = rs.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/**
 * Where the terms (and phrases) occur in `text`. A term matches at the start of a word; if it never does, anywhere
 * (so "læge" still lights up inside "tandlæge"). At most `max` ranges.
 */
export function findRanges(text: string, needles: string[], max = 24): Range[] {
  if (!text) return [];
  const hay = foldCase(text);
  const out: Range[] = [];
  const uniq = [...new Set(needles.map((n) => foldCase(n.trim())).filter(Boolean))].sort((a, b) => b.length - a.length);
  for (const n of uniq) {
    const starts: number[] = [];
    const inside: number[] = [];
    let i = hay.indexOf(n);
    while (i !== -1 && starts.length + inside.length < max) {
      (isWordChar(hay[i - 1]) && isWordChar(n[0]) ? inside : starts).push(i);
      i = hay.indexOf(n, i + Math.max(1, n.length));
    }
    // Inside a word only for 4+ letters ("læge" in "tandlæge"); "ny" never lights up inside "any".
    for (const s of starts.length ? starts : n.length >= 4 ? inside : []) out.push([s, s + n.length]);
  }
  return mergeRanges(out).slice(0, max);
}

/** Highlight ranges for a parsed query: phrases first, then words. */
export function rangesFor(text: string, q: { terms: string[]; phrases?: string[] }): Range[] {
  return findRanges(text, [...(q.phrases ?? []), ...q.terms]);
}

/**
 * A short passage around the first match: about `size` characters, cut at word boundaries, "…" where cut. Ranges
 * are relative to the returned text. Without a match, the start of the text (no ranges).
 */
export function makeSnippet(text: string, needles: string[], size = 150): { text: string; ranges: Range[] } {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return { text: "", ranges: [] };
  const all = findRanges(clean, needles, 64);
  if (clean.length <= size) return { text: clean, ranges: all };
  const first = all[0];
  let start = first ? Math.max(0, first[0] - Math.floor(size / 3)) : 0;
  let end = Math.min(clean.length, start + size);
  if (end === clean.length) start = Math.max(0, end - size);
  // Snap to word boundaries.
  if (start > 0) { const sp = clean.indexOf(" ", start); if (sp !== -1 && sp < (first?.[0] ?? start + 20)) start = sp + 1; }
  if (end < clean.length) { const sp = clean.lastIndexOf(" ", end); if (sp > (first?.[1] ?? start)) end = sp; }
  const pre = start > 0 ? "…" : "";
  const post = end < clean.length ? "…" : "";
  const body = clean.slice(start, end);
  const ranges = all
    .filter(([a, b]) => a >= start && b <= end)
    .map(([a, b]) => [a - start + pre.length, b - start + pre.length] as Range);
  return { text: pre + body + post, ranges };
}

/** Split text into plain/marked parts for rendering. */
export function splitByRanges(text: string, ranges: Range[]): { text: string; hit: boolean }[] {
  const out: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (const [a, b] of mergeRanges(ranges)) {
    if (a < at || a >= text.length) continue;
    if (a > at) out.push({ text: text.slice(at, a), hit: false });
    out.push({ text: text.slice(a, Math.min(b, text.length)), hit: true });
    at = Math.min(b, text.length);
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}

/** The readable words of an artifact's JSON content (headings, paragraphs, bullets), not its keys or ids. */
export function jsonText(content: unknown, max = 20_000): string {
  const out: string[] = [];
  let size = 0;
  const walk = (x: unknown, key: string) => {
    if (size > max) return;
    if (typeof x === "string") {
      if (/^(id|.*Id|kind|type|style|layout|status|designSetId|href|url|src)$/.test(key) || /^[0-9a-f-]{36}$/i.test(x) || x.length < 3) return;
      out.push(x); size += x.length + 1;
    } else if (Array.isArray(x)) x.forEach((y) => walk(y, key));
    else if (x && typeof x === "object") for (const [k, y] of Object.entries(x)) walk(y, k);
  };
  walk(content, "");
  return out.join(" ").replace(/\s+/g, " ");
}
