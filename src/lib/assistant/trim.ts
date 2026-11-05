/**
 * Keeping tool answers small before a model reads them (pure, unit-tested; mux's assistant does the same with its
 * own tools). Long arrays keep their first items and say how many more there were; long strings keep their start
 * and end; a whole answer over the cap is cut with a hint to ask for less.
 */

export const RESULT_CHARS = 6000;

/** Long arrays → the first `items` + "… N more"; long strings → start + end; objects walked (depth-limited). */
export function compactValue(v: unknown, opts: { items?: number; chars?: number } = {}, depth = 0): unknown {
  const items = opts.items ?? 20;
  const chars = opts.chars ?? 1500;
  if (Array.isArray(v)) {
    const keep = v.slice(0, items).map((x) => compactValue(x, opts, depth + 1));
    return v.length > items ? [...keep, `… ${v.length - items} more`] : keep;
  }
  if (v && typeof v === "object") {
    if (depth > 6) return "…";
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, compactValue(x, opts, depth + 1)]));
  }
  if (typeof v === "string" && v.length > chars) {
    const head = Math.round(chars * 0.6);
    return `${v.slice(0, head)} … ${v.slice(-(chars - head))}`;
  }
  return v;
}

/** A text cut at `max` characters, with what to do about it. */
export function clipResult(s: string, max = RESULT_CHARS): string {
  return s.length > max ? `${s.slice(0, max)}\n… (cut at ${max} characters: ask for less, e.g. with a filter or a limit)` : s;
}

/** JSON for a model: compacted, then clipped. */
export function compactJson(v: unknown, max = RESULT_CHARS): string {
  let json: string;
  try { json = JSON.stringify(compactValue(v)); } catch { json = String(v); }
  return clipResult(json ?? "null", max);
}
