/**
 * Type colours for mentions and highlights. The six original types have tokens in globals.css (--t-person …); the
 * newer ones (organization, project, thing) fall back to fixed hues until globals.css gains --t-organization,
 * --t-project and --t-thing.
 */
const FALLBACK: Record<string, string> = { organization: "#3d7f8c", project: "#9a4f78", thing: "#6c7140" };

export function typeColor(type: string | null | undefined): string {
  const t = type ?? "";
  if (["person", "place", "event", "topic", "document", "source"].includes(t)) return `var(--t-${t})`;
  return FALLBACK[t] ? `var(--t-${t}, ${FALLBACK[t]})` : "var(--muted)";
}

/** A pale tint of the type colour for highlights (works with CSS variables via color-mix). */
export function typeTint(type: string | null | undefined, pct = 14): string {
  return `color-mix(in srgb, ${typeColor(type)} ${pct}%, transparent)`;
}
