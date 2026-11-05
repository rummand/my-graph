import { describe, expect, it } from "vitest";
import { firstDiff, Lru, sentenceKey, splitSentences } from "./sentences";

const texts = (t: string) => splitSentences(t).map((s) => `${s.complete ? "+" : "-"}${s.text}`);

describe("sentence splitting", () => {
  it("splits on end punctuation and line breaks, keeping offsets", () => {
    const t = "Emma swims. Noah too!\nAnd Bo";
    const ss = splitSentences(t);
    expect(ss.map((s) => s.text)).toEqual(["Emma swims.", "Noah too!", "And Bo"]);
    expect(ss.map((s) => t.slice(s.start, s.end))).toEqual(["Emma swims.", "Noah too!", "And Bo"]);
    expect(ss.map((s) => s.complete)).toEqual([true, true, false]);
  });
  it("doesn't end on abbreviations, numbers before lowercase, or dots inside words", () => {
    expect(texts("Dr. Mette Lund ringede kl. 14. Det er den 12. marts. Se example.com nu.")).toEqual([
      "+Dr. Mette Lund ringede kl. 14.", "+Det er den 12. marts.", "+Se example.com nu.",
    ]);
    expect(texts("Vi ses f.eks. i morgen.")).toEqual(["+Vi ses f.eks. i morgen."]);
  });
  it("a number with a full stop at the very end isn't finished yet", () => {
    expect(texts("Den 12.")).toEqual(["-Den 12."]);
    expect(texts("Den 12. Marts")).toEqual(["+Den 12.", "-Marts"]);
  });
  it("cuts very long runs", () => {
    const long = "ord ".repeat(300);
    expect(splitSentences(long).length).toBeGreaterThan(1);
  });
});

describe("sentence keys", () => {
  it("are stable for the same words and differ otherwise", () => {
    expect(sentenceKey("Emma  swims.")).toBe(sentenceKey(" Emma swims. "));
    expect(sentenceKey("Emma swims.")).not.toBe(sentenceKey("Emma swam."));
  });
  it("don't change when other sentences change", () => {
    const a = splitSentences("Emma swims. Noah reads.");
    const b = splitSentences("Today Emma swims a lot. Noah reads.");
    expect(a[1].key).toBe(b[1].key);
    expect(a[1].start).not.toBe(b[1].start);
  });
});

describe("helpers", () => {
  it("firstDiff finds the edit point", () => {
    expect(firstDiff("abc", "abXc")).toBe(2);
    expect(firstDiff("abc", "abc")).toBe(3);
  });
  it("Lru keeps the most recently used", () => {
    const l = new Lru<string, number>(2);
    l.set("a", 1).set("b", 2);
    l.get("a");
    l.set("c", 3);
    expect([l.has("a"), l.has("b"), l.has("c")]).toEqual([true, false, true]);
  });
});
