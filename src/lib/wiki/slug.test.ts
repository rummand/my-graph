import { describe, expect, it } from "vitest";
import { slugify, uniqueSlug } from "./slug";

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Anna's first day at Skovbo Skole!")).toBe("annas-first-day-at-skovbo-skole");
  });
  it("spells out Danish letters and strips accents", () => {
    expect(slugify("Sommerferie på Ærø — Søren")).toBe("sommerferie-paa-aeroe-soeren");
    expect(slugify("Café crème")).toBe("cafe-creme");
  });
  it("trims separators and collapses runs", () => {
    expect(slugify("  --Hello   world--  ")).toBe("hello-world");
  });
  it("falls back to 'page' for titles without letters or digits", () => {
    expect(slugify("!!!")).toBe("page");
    expect(slugify("🙂")).toBe("page");
  });
  it("caps length without a trailing hyphen", () => {
    const s = slugify("word ".repeat(40));
    expect(s.length).toBeLessThanOrEqual(80);
    expect(s.endsWith("-")).toBe(false);
  });
});

describe("uniqueSlug", () => {
  it("returns the base when free", () => {
    expect(uniqueSlug("school", ["other"])).toBe("school");
  });
  it("suffixes -2, -3 on clashes", () => {
    expect(uniqueSlug("school", ["school"])).toBe("school-2");
    expect(uniqueSlug("school", ["school", "school-2"])).toBe("school-3");
  });
  it("never returns a reserved route name bare", () => {
    expect(uniqueSlug("new", [])).toBe("new-2");
  });
});
