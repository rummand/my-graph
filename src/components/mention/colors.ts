/** Type colours for mentions and highlights: every node type has a --t-<type> token in globals.css (light + dark). */
const TYPES = ["person", "place", "event", "topic", "document", "source", "organization", "project", "thing"];
/** Types whose token may not be in globals.css yet: the fallback hex keeps them coloured (and readable by the canvas). */
const FALLBACK: Record<string, string> = { commitment: "#a8741a" };

export function typeColor(type: string | null | undefined): string {
  const t = type ?? "";
  if (FALLBACK[t]) return `var(--t-${t}, ${FALLBACK[t]})`;
  return TYPES.includes(t) ? `var(--t-${t})` : "var(--muted)";
}

/** A pale tint of the type colour for highlights (works with CSS variables via color-mix). */
export function typeTint(type: string | null | undefined, pct = 14): string {
  return `color-mix(in srgb, ${typeColor(type)} ${pct}%, transparent)`;
}
