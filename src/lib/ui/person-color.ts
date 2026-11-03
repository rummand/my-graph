/**
 * Every person gets a stable hue from their id, so their colour is the same on every screen.
 * Hues are spread with the golden angle and skip the muddy yellow-green band.
 */
export function personHue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const hue = (h % 360) * 137.508 % 360;
  return hue > 55 && hue < 95 ? hue + 60 : Math.round(hue);
}

/** CSS custom properties for a person: `--h` plus ready-made solid and tint colours. */
export function personStyle(id: string): Record<string, string> {
  const h = personHue(id);
  return {
    "--h": String(h),
    "--person": `hsl(${h} var(--person-s) var(--person-l))`,
    "--person-tint": `hsl(${h} var(--person-tint-s) var(--person-tint-l))`,
  };
}

export function initials(name: string): string {
  const parts = name.replace(/^(Mr|Mrs|Ms|Dr)\.?\s+/i, "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
