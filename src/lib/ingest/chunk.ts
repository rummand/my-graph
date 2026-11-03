/**
 * Chunking. Pure. Splits extracted text into ~1200-character passages with overlap, keeping a locator that points
 * back into the original: page + character offsets within that page (PDF), character offsets (plain text), or a time
 * range (audio transcripts).
 */
import type { Locator } from "@/db/schema";

/** A unit of extracted text: one PDF page, one transcript segment, or a whole text file. */
export type TextSegment = { text: string; page?: number; timeStartSec?: number; timeEndSec?: number };
export type Chunk = { text: string; locator: Locator };

export const CHUNK_SIZE = 1200;
export const CHUNK_OVERLAP = 150;

/** Find a natural break (paragraph, sentence, then whitespace) at or before `limit`, but after `min`. */
function breakPoint(text: string, start: number, limit: number, min: number): number {
  if (limit >= text.length) return text.length;
  const window = text.slice(start, limit);
  for (const re of [/\n\s*\n/g, /[.!?…]["')\]]?\s/g, /\n/g, /\s/g]) {
    let best = -1;
    for (const m of window.matchAll(re)) {
      const end = start + (m.index ?? 0) + m[0].length;
      if (end - start >= min) best = end;
    }
    if (best > 0) return best;
  }
  return limit; // no whitespace at all: hard cut
}

/** Split one string into windows of ~size characters with ~overlap characters repeated between neighbours. */
export function splitText(text: string, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP): { start: number; end: number }[] {
  if (size <= 0) throw new Error("size must be positive");
  const ov = Math.max(0, Math.min(overlap, Math.floor(size / 2)));
  const out: { start: number; end: number }[] = [];
  let start = 0;
  // Skip leading whitespace.
  while (start < text.length && /\s/.test(text[start])) start++;
  while (start < text.length) {
    const end = breakPoint(text, start, start + size, Math.floor(size * 0.6));
    let realEnd = end;
    while (realEnd > start && /\s/.test(text[realEnd - 1])) realEnd--;
    if (realEnd > start) out.push({ start, end: realEnd });
    if (end >= text.length) break;
    // Next window starts `ov` characters back, nudged forward to a word boundary.
    let next = Math.max(end - ov, start + 1);
    if (ov > 0) {
      const ws = text.slice(next, end).search(/\s/);
      if (ws >= 0) next = next + ws;
    }
    while (next < text.length && /\s/.test(text[next])) next++;
    start = next;
  }
  return out;
}

/**
 * Chunk extracted segments.
 * - Timed segments (audio) are packed whole, in order, until a chunk reaches `size`; the last segment(s) up to
 *   `overlap` characters are repeated at the start of the next chunk. Locator: timeStartSec/timeEndSec.
 * - Other segments (pages / whole text) are split individually; locator: page (if any) + charStart/charEnd within it.
 */
export function chunkSegments(segments: TextSegment[], size = CHUNK_SIZE, overlap = CHUNK_OVERLAP): Chunk[] {
  const usable = segments.filter((s) => s.text.trim().length > 0);
  if (usable.length === 0) return [];
  const timed = usable.every((s) => typeof s.timeStartSec === "number");
  return timed ? packTimed(usable, size, overlap) : usable.flatMap((s) => splitSegment(s, size, overlap));
}

function splitSegment(s: TextSegment, size: number, overlap: number): Chunk[] {
  return splitText(s.text, size, overlap).map(({ start, end }) => ({
    text: s.text.slice(start, end),
    locator: { ...(s.page !== undefined ? { page: s.page } : {}), charStart: start, charEnd: end },
  }));
}

function packTimed(segments: TextSegment[], size: number, overlap: number): Chunk[] {
  const out: Chunk[] = [];
  let i = 0;
  while (i < segments.length) {
    const group: TextSegment[] = [];
    let len = 0;
    let j = i;
    while (j < segments.length && (group.length === 0 || len + segments[j].text.trim().length + 1 <= size)) {
      group.push(segments[j]);
      len += segments[j].text.trim().length + 1;
      j++;
    }
    const text = group.map((g) => g.text.trim()).join(" ");
    // A single very long segment: split it by characters but keep its time range.
    if (group.length === 1 && text.length > size) {
      for (const { start, end } of splitText(text, size, overlap)) {
        out.push({ text: text.slice(start, end), locator: { timeStartSec: group[0].timeStartSec, timeEndSec: group[0].timeEndSec ?? group[0].timeStartSec } });
      }
    } else {
      const last = group[group.length - 1];
      out.push({ text, locator: { timeStartSec: group[0].timeStartSec, timeEndSec: last.timeEndSec ?? last.timeStartSec } });
    }
    if (j >= segments.length) break;
    // Overlap: step back over trailing segments totalling <= overlap chars, but always advance at least one.
    let back = j;
    let ovLen = 0;
    while (back - 1 > i && ovLen + segments[back - 1].text.trim().length <= overlap) {
      back--;
      ovLen += segments[back].text.trim().length;
    }
    i = Math.max(back, i + 1);
  }
  return out;
}

/** Pack consecutive chunks into groups of roughly `maxChars` for one extraction call. */
export function groupChunks<T extends { text: string }>(items: T[], maxChars = 4000): T[][] {
  const groups: T[][] = [];
  let cur: T[] = [];
  let len = 0;
  for (const it of items) {
    if (cur.length > 0 && len + it.text.length > maxChars) {
      groups.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(it);
    len += it.text.length;
  }
  if (cur.length) groups.push(cur);
  return groups;
}

/** Format a locator for people: "p. 3", "1:05–2:10", "chars 0–1200". */
export function formatLocator(l: Locator | null | undefined): string {
  if (!l) return "";
  const parts: string[] = [];
  if (l.page !== undefined) parts.push(`p. ${l.page}`);
  if (l.timeStartSec !== undefined) parts.push(`${formatTime(l.timeStartSec)}–${formatTime(l.timeEndSec ?? l.timeStartSec)}`);
  else if (l.charStart !== undefined && l.page === undefined) parts.push(`chars ${l.charStart}–${l.charEnd ?? l.charStart}`);
  return parts.join(" · ");
}

export function formatTime(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
