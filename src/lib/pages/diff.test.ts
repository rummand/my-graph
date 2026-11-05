import { describe, expect, it } from "vitest";
import { collapseUnchanged, diffStats, tokenize, wordDiff, type DiffSegment } from "./diff";

const side = (segs: DiffSegment[], keep: "add" | "del") => segs.filter((s) => s.op === "eq" || s.op === keep).map((s) => s.text).join("");

describe("wordDiff", () => {
  it("returns a single equal segment for identical text", () => {
    expect(wordDiff("same text", "same text")).toEqual([{ op: "eq", text: "same text" }]);
    expect(wordDiff("", "")).toEqual([]);
  });
  it("marks a replaced word", () => {
    expect(wordDiff("Anna starts Monday", "Anna starts Tuesday")).toEqual([
      { op: "eq", text: "Anna starts " }, { op: "del", text: "Monday" }, { op: "add", text: "Tuesday" },
    ]);
  });
  it("marks insertions and deletions in the middle", () => {
    const d = wordDiff("pack the blue bag today", "pack the bag and lunch today");
    expect(side(d, "del")).toBe("pack the blue bag today");
    expect(side(d, "add")).toBe("pack the bag and lunch today");
    expect(diffStats(d)).toEqual({ added: 2, removed: 1 });
  });
  it("handles empty sides", () => {
    expect(wordDiff("", "new words")).toEqual([{ op: "add", text: "new words" }]);
    expect(wordDiff("old words", "")).toEqual([{ op: "del", text: "old words" }]);
  });
  it("reconstructs both sides for random edits", () => {
    const words = ["a", "b", "c", "d", "e", "f", "\n\n", " "];
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let t = 0; t < 200; t++) {
      const mk = () => Array.from({ length: Math.floor(rnd() * 30) }, () => words[Math.floor(rnd() * words.length)]).join(" ");
      const a = mk(), b = mk();
      const d = wordDiff(a, b);
      expect(side(d, "del")).toBe(a);
      expect(side(d, "add")).toBe(b);
    }
  });
  it("falls back to replace-all when texts are too different", () => {
    const d = wordDiff("a b c d", "w x y z", 1);
    expect(side(d, "del")).toBe("a b c d");
    expect(side(d, "add")).toBe("w x y z");
  });
});

describe("tokenize", () => {
  it("keeps whitespace so tokens join back to the original", () => {
    const t = "Hello,  world\n\nnext";
    expect(tokenize(t).join("")).toBe(t);
  });
});

describe("collapseUnchanged", () => {
  it("keeps context around a change and folds the rest", () => {
    const before = Array.from({ length: 100 }, (_, i) => `w${i}`).join(" ");
    const after = before.replace("w50", "CHANGED");
    const out = collapseUnchanged(wordDiff(before, after), 3);
    expect(out[0]).toEqual({ op: "gap", words: 47 });
    expect(out.some((s) => s.op === "add" && s.text === "CHANGED")).toBe(true);
    expect(out[out.length - 1]).toEqual({ op: "gap", words: 46 });
  });
  it("leaves short unchanged runs alone", () => {
    const segs = wordDiff("a b c", "a x c");
    expect(collapseUnchanged(segs, 3)).toEqual(segs);
  });
});
