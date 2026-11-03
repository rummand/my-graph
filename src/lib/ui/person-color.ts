/**
 * Every person gets a stable hue from their id, so their colour is the same on every screen.
 * The id is hashed with FNV-1a plus a final mix (uuids differ mostly in a few characters, which a plain polynomial
 * hash clusters), then spread evenly over the wheel minus the muddy yellow-green band (60–125°), whole degrees only.
 * The old version moved that band +60°, piling extra people into green.
 */
export function personHue(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12;
  const u = (h >>> 0) % 295; // 360 − the 65° band
  return u < 60 ? u : u + 65;
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
