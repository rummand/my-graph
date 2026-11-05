/**
 * The instant tier of live highlights (pure, safe for client components): a matcher over the graph's names.
 *
 * `buildMatcher` folds every label and alias (case, diacritics, æ/ø/å, runs of spaces) into a trie. `match` walks the
 * folded text once, trying the trie only at word starts, and keeps the longest name at each start, so "Sofie Lund"
 * beats "Sofie" and nothing overlaps. Names match whole words, plus a few safe Danish/English endings: the genitive
 * -s on any name ("Emmas", "Sofie Lunds"), and definite/plural endings (-en, -et, -erne …) on lowercase single-word
 * things ("radiatoren"). Labels of one or two letters must match with the same case ("Bo", not "bo").
 *
 * Built once per lexicon version; a match over a few thousand characters against thousands of labels takes well under
 * a millisecond.
 */

export type LexEntry = {
  id: string;
  label: string;
  aliases?: string[];
  type: string;
  kind?: string | null;
  kindLabel?: string | null;
  /** The viewer's own person node: "you", never highlighted as a link. */
  self?: boolean;
  sensitive?: boolean;
};

export type LexMatch = { start: number; end: number; text: string; entry: LexEntry };

type Payload = { entry: LexEntry; name: string; nounish: boolean; exactCase: boolean };
type TrieNode = { next: Map<number, TrieNode>; out: Payload | null };

const FOLD: Record<string, string> = { æ: "ae", ø: "o", å: "a", ä: "a", ö: "o", ü: "u", ß: "ss", "’": "'", "‘": "'", "ʼ": "'", "´": "'" };
const WORD = /[\p{L}\p{N}]/u;
const SPACE = /\s/u;

/** Fold one character (lowercase, no diacritics). May return two letters (æ → ae) or an empty string (a lone mark). */
export function foldChar(c: string): string {
  const l = c.toLowerCase();
  const f = FOLD[l];
  if (f !== undefined) return f;
  if (l.charCodeAt(0) < 128) return l;
  return l.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export type Folded = { s: string; /** original index of each folded char */ at: number[]; word: boolean[] };

/** Fold a whole text, keeping a map back to the original offsets. Whitespace runs become one space. */
export function foldText(text: string): Folded {
  let s = "";
  const at: number[] = [];
  let prevSpace = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (SPACE.test(c)) {
      if (!prevSpace) { s += " "; at.push(i); }
      prevSpace = true;
      continue;
    }
    prevSpace = false;
    const f = foldChar(c);
    for (let k = 0; k < f.length; k++) { s += f[k]; at.push(i); }
  }
  const word = new Array<boolean>(s.length);
  for (let i = 0; i < s.length; i++) word[i] = WORD.test(s[i]);
  return { s, at, word };
}

export const foldName = (s: string) => foldText(s.trim()).s;

const TITLE = /^(dr|mr|mrs|ms|prof|hr|fru|frk)\.?\s+(?=\S)/i;
/** Endings that may follow a name: genitive. */
const GENITIVE = ["s"];
/** Definite/plural endings on lowercase common nouns (Danish), longest first. */
const NOUN_ENDINGS = ["ernes", "erne", "enes", "ene", "ens", "ets", "en", "et", "er", "es", "e", "s"];

export type Matcher = { match: (text: string) => LexMatch[]; size: number };

export function buildMatcher(entries: LexEntry[]): Matcher {
  const root: TrieNode = { next: new Map(), out: null };
  let size = 0;
  const add = (name: string, entry: LexEntry) => {
    const raw = name.trim();
    const key = foldName(raw);
    if (key.length < 2 || !WORD.test(key[0]) && key.length < 3) return;
    let node = root;
    for (let i = 0; i < key.length; i++) {
      const c = key.charCodeAt(i);
      let n = node.next.get(c);
      if (!n) { n = { next: new Map(), out: null }; node.next.set(c, n); }
      node = n;
    }
    if (node.out) return; // first entry wins (callers sort by priority)
    const nounish = entry.type !== "person" && raw === raw.toLowerCase() && !/\s/.test(raw) && key.length >= 4;
    node.out = { entry, name: raw, nounish, exactCase: key.length <= 2 };
    size++;
  };
  for (const e of entries) {
    for (const name of [e.label, ...(e.aliases ?? [])]) {
      if (!name) continue;
      add(name, e);
      const untitled = name.replace(TITLE, "");
      if (untitled !== name && untitled.trim().split(/\s+/).length >= 2) add(untitled, e);
    }
  }

  function match(text: string): LexMatch[] {
    const out: LexMatch[] = [];
    if (!size || !text) return out;
    const f = foldText(text);
    const { s, word } = f;
    const n = s.length;
    const boundary = (k: number) => k >= n || !word[k];
    const ending = (k: number, p: Payload): number => {
      if (boundary(k)) return k;
      for (const suf of p.nounish ? NOUN_ENDINGS : GENITIVE) {
        if (s.startsWith(suf, k) && boundary(k + suf.length)) return k + suf.length;
      }
      return -1;
    };
    for (let i = 0; i < n; i++) {
      if (i > 0 && word[i - 1]) continue;
      if (s.charCodeAt(i) === 32) continue;
      let node: TrieNode | undefined = root;
      let best: { end: number; p: Payload } | null = null;
      for (let j = i; j < n; j++) {
        node = node.next.get(s.charCodeAt(j));
        if (!node) break;
        if (node.out) {
          const end = ending(j + 1, node.out);
          if (end >= 0) best = { end, p: node.out };
        }
      }
      if (!best) continue;
      const start = f.at[i];
      const end = best.end >= n ? text.length : f.at[best.end];
      const endTrim = trimEnd(text, start, end);
      const surface = text.slice(start, endTrim);
      if (best.p.exactCase && !surface.startsWith(best.p.name)) continue;
      out.push({ start, end: endTrim, text: surface, entry: best.p.entry });
      i = best.end - 1;
    }
    return out;
  }

  return { match, size };
}

/** Don't let a span end in whitespace (a folded space maps back to the first of a run). */
function trimEnd(text: string, start: number, end: number): number {
  let e = end;
  while (e > start && SPACE.test(text[e - 1])) e--;
  return e;
}
