import { describe, expect, it } from "vitest";
import { chunkSegments, formatLocator, formatTime, groupChunks, splitText } from "./chunk";

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

describe("splitText", () => {
  it("returns one window for short text", () => {
    expect(splitText("Hello there.", 1200, 150)).toEqual([{ start: 0, end: 12 }]);
  });

  it("covers the whole text with windows no longer than size, overlapping", () => {
    const text = words(800); // ~6000 chars
    const w = splitText(text, 1200, 150);
    expect(w.length).toBeGreaterThan(4);
    expect(w[0].start).toBe(0);
    expect(w[w.length - 1].end).toBe(text.length);
    for (let i = 0; i < w.length; i++) {
      expect(w[i].end - w[i].start).toBeLessThanOrEqual(1200);
      if (i > 0) {
        expect(w[i].start).toBeLessThan(w[i - 1].end); // overlap
        expect(w[i].start).toBeGreaterThan(w[i - 1].start); // progress
      }
    }
  });

  it("does not cut words in half", () => {
    const text = words(500);
    for (const { start, end } of splitText(text, 1200, 150)) {
      expect(text[start - 1] === undefined || /\s/.test(text[start - 1])).toBe(true);
      expect(text[end] === undefined || /\s/.test(text[end])).toBe(true);
    }
  });

  it("prefers paragraph breaks", () => {
    const a = "A".repeat(900).replace(/(.{50})/g, "$1 ");
    const text = `${a.trim()}\n\nSecond paragraph ${words(200)}`;
    const [first] = splitText(text, 1200, 150);
    expect(text.slice(first.start, first.end).endsWith("A")).toBe(true);
    expect(text.slice(first.end, first.end + 2)).toBe("\n\n");
  });

  it("hard-cuts text without whitespace", () => {
    const w = splitText("x".repeat(3000), 1200, 100);
    expect(w[0]).toEqual({ start: 0, end: 1200 });
    expect(w[w.length - 1].end).toBe(3000);
  });

  it("terminates with zero overlap and on whitespace-only input", () => {
    expect(splitText(words(400), 500, 0).length).toBeGreaterThan(1);
    expect(splitText("   \n\n  ", 1200, 150)).toEqual([]);
  });
});

describe("chunkSegments", () => {
  it("keeps page numbers and per-page offsets for PDFs", () => {
    const p2 = words(300);
    const chunks = chunkSegments([{ text: "Short page one.", page: 1 }, { text: p2, page: 2 }, { text: "  ", page: 3 }]);
    expect(chunks[0]).toEqual({ text: "Short page one.", locator: { page: 1, charStart: 0, charEnd: 15 } });
    const page2 = chunks.filter((c) => c.locator.page === 2);
    expect(page2.length).toBeGreaterThan(1);
    for (const c of page2) expect(p2.slice(c.locator.charStart!, c.locator.charEnd!)).toBe(c.text);
    expect(chunks.some((c) => c.locator.page === 3)).toBe(false);
  });

  it("omits page for plain text", () => {
    const [c] = chunkSegments([{ text: "Plain note" }]);
    expect(c.locator).toEqual({ charStart: 0, charEnd: 10 });
  });

  it("packs timed segments and keeps time ranges", () => {
    const segs = Array.from({ length: 40 }, (_, i) => ({ text: `Sentence number ${i} said in the recording here.`, timeStartSec: i * 5, timeEndSec: i * 5 + 5 }));
    const chunks = chunkSegments(segs, 300, 60);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks[0].locator.timeStartSec).toBe(0);
    expect(chunks[chunks.length - 1].locator.timeEndSec).toBe(200);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(300);
      expect(c.locator.timeEndSec!).toBeGreaterThan(c.locator.timeStartSec!);
    }
    // overlap: the next chunk starts before the previous one ended
    expect(chunks[1].locator.timeStartSec!).toBeLessThan(chunks[0].locator.timeEndSec!);
  });

  it("splits a single very long timed segment", () => {
    const chunks = chunkSegments([{ text: words(400), timeStartSec: 3, timeEndSec: 90 }], 500, 50);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((c) => c.locator.timeStartSec === 3 && c.locator.timeEndSec === 90)).toBe(true);
  });

  it("returns nothing for empty input", () => {
    expect(chunkSegments([])).toEqual([]);
    expect(chunkSegments([{ text: "" }])).toEqual([]);
  });
});

describe("groupChunks", () => {
  it("groups by character budget and never drops items", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ text: "x".repeat(1500), i }));
    const groups = groupChunks(items, 4000);
    expect(groups.map((g) => g.length)).toEqual([2, 2, 2, 2, 2]);
    expect(groupChunks([{ text: "y".repeat(9000) }], 4000)).toHaveLength(1);
  });
});

describe("formatting", () => {
  it("formats locators and times", () => {
    expect(formatLocator({ page: 3, charStart: 0, charEnd: 10 })).toBe("p. 3");
    expect(formatLocator({ timeStartSec: 65, timeEndSec: 130 })).toBe("1:05–2:10");
    expect(formatLocator({ charStart: 5, charEnd: 9 })).toBe("chars 5–9");
    expect(formatLocator({})).toBe("");
    expect(formatTime(3725)).toBe("1:02:05");
  });
});

describe("locators beyond pages", () => {
  it("carries slide, sheet/range and picture regions onto every chunk and formats them", () => {
    const [c] = chunkSegments([{ text: "Slide 2: Plan", at: { slide: 2 } }]);
    expect(c.locator).toEqual({ slide: 2, charStart: 0, charEnd: 13 });
    expect(formatLocator(c.locator)).toBe("slide 2");
    const [s] = chunkSegments([{ text: "| a | b |", at: { sheet: "Budget", range: "A1:B9" } }]);
    expect(formatLocator(s.locator)).toBe("Budget A1:B9");
    expect(formatLocator({ page: 3, image: "page 3", region: "top" })).toBe("p. 3 · top");
  });
});
