/**
 * Code lists (pure): checking the ICD-10 and ICPC-2 codes the assistant suggests against the official lists bundled in
 * assets/codes (see assets/codes/SOURCES.md). A code that isn't in the list is dropped; a code that is gets its
 * official title (in the session's language, the other language as fallback); and when the model's own wording for
 * it shares nothing with the official title in either language, the suggestion is flagged so the clinician looks twice.
 */
import type { CodeSuggestion, CodeSystem } from "./pure";

/** code → [english title | null, danish title | null] */
export type CodeTable = Record<string, [string | null, string | null]>;
export type CodeTables = { "ICD-10": CodeTable; "ICPC-2": CodeTable };

export type CheckedCode = CodeSuggestion & {
  /** The official title in the session's language (or the other one when that's all there is). */
  officialTitle: string;
  /** What the model called it (kept so the clinician can see the difference). */
  suggestedAs: string;
  /** The model's wording doesn't match the official title. */
  mismatch: boolean;
};

/**
 * The entry for a code. National extensions fall back to the official code they extend: ICPC-2 "T90.02" (Norwegian
 * and Danish sub-codes) → "T90"; ICD-10 "F32.11" (a fifth character) → "F32.1". A made-up subcategory ("F39.5") is
 * not quietly turned into its parent.
 */
export function lookupCode(table: CodeTable, code: string, system: CodeSystem = "ICD-10"): { code: string; en: string | null; da: string | null } | null {
  const c = code.toUpperCase().trim();
  const tries = [c];
  const [head, tail] = c.split(".");
  if (tail !== undefined) {
    if (system === "ICPC-2") tries.push(head);
    else if (tail.length > 1) tries.push(`${head}.${tail[0]}`);
  }
  for (const k of tries) {
    const hit = table[k];
    if (hit) return { code: k, en: hit[0], da: hit[1] };
  }
  return null;
}

const STOP = new Set([
  "and", "or", "of", "the", "with", "without", "other", "unspecified", "nos", "nec", "not", "elsewhere", "classified", "due", "to", "in", "a", "an", "by", "for", "on",
  "og", "eller", "af", "med", "uden", "andre", "anden", "andet", "uspecificeret", "ika", "ikke", "til", "i", "pa", "ved", "for", "en", "et", "som",
]);

/** Words reduced to comparable stems: lower case, accents off, short words and filler dropped, first 5 letters kept. */
export function stems(s: string): Set<string> {
  const words = s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/æ/g, "ae").replace(/ø/g, "o").replace(/å/g, "a")
    .split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w));
  return new Set(words.map((w) => w.slice(0, 5)));
}

/** Does the model's wording share at least one meaningful word stem with the official title (either language)? */
export function wordingMatches(label: string, titles: (string | null)[]): boolean {
  const mine = stems(label);
  if (!mine.size) return true; // nothing to compare: not a mismatch, just no wording
  for (const t of titles) {
    if (!t) continue;
    const theirs = stems(t);
    for (const w of mine) if (theirs.has(w)) return true;
  }
  return false;
}

/**
 * Suggestions (already checked for evidence by parseCodeSuggestions) → only codes that exist, with the official title
 * and a mismatch flag. A mismatch lowers the confidence to at most 0.3 so it sorts last.
 */
export function checkCodes(list: CodeSuggestion[], tables: CodeTables, lang: "da" | "en"): CheckedCode[] {
  const out: CheckedCode[] = [];
  const seen = new Set<string>();
  for (const s of list) {
    const hit = lookupCode(tables[s.system], s.code, s.system);
    if (!hit) continue;
    const key = `${s.system}:${hit.code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const officialTitle = (lang === "da" ? hit.da ?? hit.en : hit.en ?? hit.da) ?? "";
    const mismatch = !!s.label && !wordingMatches(s.label, [hit.en, hit.da]);
    out.push({ ...s, code: hit.code, label: officialTitle, officialTitle, suggestedAs: s.label, mismatch, confidence: mismatch ? Math.min(s.confidence, 0.3) : s.confidence });
  }
  return out.sort((a, b) => Number(a.mismatch) - Number(b.mismatch) || b.confidence - a.confidence);
}
