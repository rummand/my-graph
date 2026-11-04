/**
 * @mention markup and span mapping (pure, safe for client components).
 *
 * Text stores a mention as `@[Label](node:<uuid>)`. Editors show it as "@Label" and keep the ids beside the text;
 * `toMarkup` / `fromMarkup` convert between the two. `locateSpans` finds where extracted entities sit in the text, for
 * the live highlights in the composer.
 */

export const MENTION_RE = /@\[([^\]]+)\]\(node:([0-9a-f-]{36})\)/g;

export type ParsedMention = { label: string; nodeId: string; start: number; end: number };

/** Every mention in a marked-up text, in order. */
export function parseMentions(text: string): ParsedMention[] {
  const out: ParsedMention[] = [];
  for (const m of text.matchAll(new RegExp(MENTION_RE.source, "g"))) {
    out.push({ label: m[1], nodeId: m[2].toLowerCase(), start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  return out;
}

/** Unique node ids mentioned in a text. */
export function mentionedIds(text: string): string[] {
  return [...new Set(parseMentions(text).map((m) => m.nodeId))];
}

const escapeLabel = (l: string) => l.replace(/[[\]]/g, "").trim();

/** One mention as markup. */
export function mentionMarkup(label: string, nodeId: string): string {
  return `@[${escapeLabel(label)}](node:${nodeId})`;
}

/** Marked-up text → what a plain editor shows ("@Label") plus the mentions it carries. */
export function fromMarkup(text: string): { text: string; mentions: { label: string; nodeId: string }[] } {
  const mentions: { label: string; nodeId: string }[] = [];
  const plain = text.replace(new RegExp(MENTION_RE.source, "g"), (_m, label: string, id: string) => {
    if (!mentions.some((x) => x.nodeId === id && x.label === label)) mentions.push({ label, nodeId: id });
    return `@${label}`;
  });
  return { text: plain, mentions };
}

/** Plain editor text ("@Label") + its mentions → marked-up text. Longest labels first so "@Emma Hansen" beats "@Emma". */
export function toMarkup(text: string, mentions: { label: string; nodeId: string }[]): string {
  if (!mentions.length) return text;
  const sorted = [...mentions].sort((a, b) => b.label.length - a.label.length);
  const pattern = new RegExp(`@(${sorted.map((m) => escapeRe(m.label)).join("|")})(?![\\p{L}\\p{N}])`, "gu");
  return text.replace(pattern, (_m, label: string) => {
    const hit = sorted.find((m) => m.label === label)!;
    return mentionMarkup(hit.label, hit.nodeId);
  });
}

/** Mark the first plain occurrence of each label as a mention (after Send created the nodes). Skips existing markup. */
export function linkFirstOccurrences(text: string, links: { label: string; nodeId: string }[]): string {
  let out = text;
  for (const l of [...links].sort((a, b) => b.label.length - a.label.length)) {
    const parts = splitOutsideMarkup(out);
    let done = false;
    out = parts.map((p) => {
      if (done || p.markup) return p.text;
      const i = findWord(p.text, l.label);
      if (i < 0) return p.text;
      done = true;
      const at = i > 0 && p.text[i - 1] === "@" ? i - 1 : i;
      return p.text.slice(0, at) + mentionMarkup(l.label, l.nodeId) + p.text.slice(i + l.label.length);
    }).join("");
  }
  return out;
}

function splitOutsideMarkup(text: string): { text: string; markup: boolean }[] {
  const out: { text: string; markup: boolean }[] = [];
  let last = 0;
  for (const m of parseMentions(text)) {
    if (m.start > last) out.push({ text: text.slice(last, m.start), markup: false });
    out.push({ text: text.slice(m.start, m.end), markup: true });
    last = m.end;
  }
  if (last < text.length) out.push({ text: text.slice(last), markup: false });
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);

/** Index of `needle` in `hay` at word boundaries: exact case first, then any case. -1 when absent. */
export function findWord(hay: string, needle: string, from = 0): number {
  if (!needle) return -1;
  for (const [h, n] of [[hay, needle], [hay.toLowerCase(), needle.toLowerCase()]] as const) {
    let i = h.indexOf(n, from);
    while (i >= 0) {
      if (!isWordChar(hay[i - 1]) && !isWordChar(hay[i + needle.length])) return i;
      i = h.indexOf(n, i + 1);
    }
  }
  return -1;
}

export type SpanInput = { ref: string; surface: string; alternatives?: string[] };
export type Span = { ref: string; start: number; end: number; text: string };

/**
 * Where each entity is named in the text: exact words first, then any case, then alternatives (the label when the
 * model's surface text isn't found). Longer names claim first; spans never overlap. Entities not found get no span.
 */
export function locateSpans(text: string, items: SpanInput[]): Span[] {
  const taken: [number, number][] = [];
  const free = (s: number, e: number) => taken.every(([a, b]) => e <= a || s >= b);
  const out: Span[] = [];
  const order = [...items].sort((a, b) => b.surface.length - a.surface.length);
  for (const it of order) {
    for (const cand of [it.surface, ...(it.alternatives ?? [])].filter((c) => c && c.trim().length >= 2)) {
      let i = findWord(text, cand);
      while (i >= 0 && !free(i, i + cand.length)) i = findWord(text, cand, i + 1);
      if (i >= 0) {
        taken.push([i, i + cand.length]);
        out.push({ ref: it.ref, start: i, end: i + cand.length, text: text.slice(i, i + cand.length) });
        break;
      }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Pieces of `text` split by spans, for rendering highlights. */
export function segments<S extends { start: number; end: number }>(text: string, spans: S[]): ({ text: string; span: null } | { text: string; span: S })[] {
  const out: ({ text: string; span: null } | { text: string; span: S })[] = [];
  let last = 0;
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    if (s.start < last || s.end > text.length) continue;
    if (s.start > last) out.push({ text: text.slice(last, s.start), span: null });
    out.push({ text: text.slice(s.start, s.end), span: s });
    last = s.end;
  }
  if (last < text.length) out.push({ text: text.slice(last), span: null });
  return out;
}

/**
 * Names of known nodes that appear in the text (whole words, at least 3 letters), longest first: the offline part of
 * live highlighting, so links to existing things show even when mux is down.
 */
export function findKnownNames<N extends { id: string; label: string; aliases?: string[] }>(text: string, known: N[]): { node: N; start: number; end: number }[] {
  const names = known.flatMap((n) => [n.label, ...(n.aliases ?? [])].filter((l) => l.trim().length >= 3).map((l) => ({ n, l })))
    .sort((a, b) => b.l.length - a.l.length);
  const taken: [number, number][] = [];
  const out: { node: N; start: number; end: number }[] = [];
  for (const { n, l } of names) {
    if (out.some((o) => o.node.id === n.id)) continue;
    const i = findWord(text, l);
    if (i < 0 || !taken.every(([a, b]) => i + l.length <= a || i >= b)) continue;
    taken.push([i, i + l.length]);
    out.push({ node: n, start: i, end: i + l.length });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The "@query" being typed at the caret, if any: the text after the last "@" at a word start, up to 40 characters. */
export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && isWordChar(before[at - 1])) return null; // an email address
  const q = before.slice(at + 1);
  if (q.length > 40 || /[\n@]/.test(q) || /^\s/.test(q) || /\s{2,}$/.test(q)) return null;
  return { start: at, query: q };
}
