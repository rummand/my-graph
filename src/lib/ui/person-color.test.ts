import { describe, expect, it } from "vitest";
import { personHue } from "./person-color";

describe("personHue", () => {
  it("is stable, whole degrees, and never in the yellow-green band", () => {
    for (let i = 0; i < 2000; i++) {
      const id = `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;
      const h = personHue(id);
      expect(Number.isInteger(h)).toBe(true);
      expect(h >= 0 && h < 360).toBe(true);
      expect(h >= 60 && h < 125).toBe(false);
      expect(personHue(id)).toBe(h);
    }
  });
  it("spreads similar ids around the wheel instead of clustering", () => {
    const buckets = new Array(6).fill(0);
    for (let i = 0; i < 1200; i++) buckets[Math.floor(personHue(`id-${i}`) / 60)]++;
    // bucket 1 (60–120) is the skipped band; the rest each get a fair share.
    for (const [b, n] of buckets.entries()) if (b !== 1) expect(n).toBeGreaterThan(150);
  });
});
