/** Page slugs: readable, URL-safe, unique per household. Pure — no DB. */

/** Slugs that collide with routes under /wiki. */
export const RESERVED_SLUGS = new Set(["new", "history", "api", "edit"]);

const MAX_SLUG = 80;

/**
 * "Anna's first day at Skovbo Skole!" → "annas-first-day-at-skovbo-skole".
 * Danish letters are spelled out (æ → ae, ø → oe, å → aa) so slugs stay readable; other accents are stripped.
 */
export function slugify(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/æ/g, "ae").replace(/ø/g, "oe").replace(/å/g, "aa").replace(/ß/g, "ss")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, "");
  return s || "page";
}

/**
 * The first free slug for `base`: base, base-2, base-3 … given the slugs already taken (in the household).
 * Reserved route names are never returned bare.
 */
export function uniqueSlug(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base) && !RESERVED_SLUGS.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}
