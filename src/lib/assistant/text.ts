/** Text helpers for conversation search (pure, unit-tested). */

/** Escape a user string for ILIKE. */
export function likePattern(q: string): string {
  return `%${q.replace(/[%_\\]/g, "\\$&")}%`;
}

/** The part of `text` around the first match of `q`, about `width` characters, with ellipses. */
export function snippetAround(text: string, q: string, width = 90): string | null {
  const t = text.replace(/\s+/g, " ").trim();
  const i = t.toLowerCase().indexOf(q.toLowerCase().trim());
  if (i < 0 || !q.trim()) return null;
  const start = Math.max(0, i - Math.floor((width - q.length) / 2));
  const end = Math.min(t.length, start + width);
  return `${start > 0 ? "…" : ""}${t.slice(start, end).trim()}${end < t.length ? "…" : ""}`;
}
