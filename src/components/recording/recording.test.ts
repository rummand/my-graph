import { describe, expect, it } from "vitest";
import { barCount, columns, speakerColumns, speechShape, timeAt, xAt } from "./peaks";
import { clock, lineAt, nextSpeed, progressInWord, searchLines, sentences, skip, startFromUrl, wordAt, wordInSentence, wordMatches, wordsOf } from "./timeline-math";

const words = [{ a: 0, b: 400, w: "Hello", line: 0 }, { a: 500, b: 900, w: "there.", line: 0 }, { a: 2000, b: 2600, w: "Hi!", line: 1 }];

describe("the finger: which word is being said", () => {
  it("is the last word that has started, and stays put between words", () => {
    expect(wordAt(words, -1)).toBe(-1);
    expect(wordAt(words, 0)).toBe(0);
    expect(wordAt(words, 450)).toBe(0); // in the gap after "Hello"
    expect(wordAt(words, 500)).toBe(1);
    expect(wordAt(words, 1999)).toBe(1);
    expect(wordAt(words, 99_999)).toBe(2);
    expect(wordAt([], 10)).toBe(-1);
    expect(lineAt([{ a: 0 }, { a: 2000 }], 2500)).toBe(1);
    expect(progressInWord(words[0], 200)).toBe(0.5);
  });

  it("is fast on long meetings (binary search)", () => {
    const many = Array.from({ length: 200_000 }, (_, i) => ({ a: i * 300 }));
    expect(wordAt(many, 300 * 123_456 + 10)).toBe(123_456);
  });

  it("follows a sentence read aloud by its share of the length", () => {
    const w = wordsOf("one two three");
    expect(wordInSentence(w, 0, 3)).toBe(0);
    expect(wordInSentence(w, 1.2, 3)).toBe(1);
    expect(wordInSentence(w, 3, 3)).toBe(2);
    expect(wordInSentence(w, 1, NaN)).toBe(0);
  });
});

describe("clock, search, links and controls", () => {
  it("formats times", () => {
    expect([clock(7_000), clock(754_000), clock(3_723_000), clock(NaN)]).toEqual(["0:07", "12:34", "1:02:03", "0:00"]);
  });

  it("finds lines holding every word, accent- and case-blind", () => {
    const lines = [{ text: "Vi mødes ved skolen", speaker: "Karen" }, { text: "The ferry is paid", speaker: "Bo" }];
    expect(searchLines(lines, "MØDES Skolen")).toEqual([0]);
    expect(searchLines([{ text: "Café au lait", speaker: null }], "cafe")).toEqual([0]);
    expect(searchLines(lines, "bo ferry")).toEqual([1]);
    expect(searchLines(lines, "  ")).toEqual([]);
    expect(wordMatches("Ferry,", "ferry")).toBe(true);
  });

  it("opens at the moment a link or citation names", () => {
    expect(startFromUrl("?t=83", "")).toBe(83_000);
    expect(startFromUrl("", "#t=1:23")).toBe(83_000);
    expect(startFromUrl("?time=4500", "")).toBe(4500);
    expect(startFromUrl("", "#t=x")).toBeNull();
  });

  it("skips 15 s within the recording and steps the speed", () => {
    expect(skip(5000, -15_000, 60_000)).toBe(0);
    expect(skip(50_000, 15_000, 60_000)).toBe(60_000);
    expect(nextSpeed(1, 1)).toBe(1.25);
    expect(nextSpeed(2, 1)).toBe(2);
    expect(nextSpeed(1, -1)).toBe(1);
  });

  it("splits text into sentences with their places", () => {
    const s = sentences("Hello there. How are you?  Fine!\nNew line");
    expect(s.map((x) => x.text)).toEqual(["Hello there.", "How are you?", "Fine!", "New line"]);
    expect("Hello there. How are you?".slice(s[1].start, s[1].end)).toBe("How are you?");
  });
});

describe("drawing the waveform", () => {
  it("makes columns from peaks, loudest per column, square-rooted against the loudest", () => {
    expect(columns([0.25, 1, 0, 0.04], 2)).toEqual([1, 0.2]);
    expect(columns([], 4)).toEqual([]);
    expect(columns([0.5], 3)).toEqual([1, 1, 1]);
  });

  it("maps the strip to moments and back", () => {
    expect(timeAt(50, 200, 60_000)).toBe(15_000);
    expect(timeAt(-5, 200, 60_000)).toBe(0);
    expect(timeAt(500, 200, 60_000)).toBe(60_000);
    expect(xAt(30_000, 200, 60_000)).toBe(100);
    expect(barCount(300)).toBe(100);
    expect(barCount(10)).toBe(20);
  });

  it("colours columns by who speaks there", () => {
    const lines = [{ a: 0, b: 4000, speaker: "Anna" }, { a: 6000, b: 10_000, speaker: "Bo" }];
    expect(speakerColumns(lines, 5, 10_000)).toEqual(["Anna", "Anna", null, "Bo", "Bo"]); // nobody speaks in the gap
    const shape = speechShape([{ a: 0, b: 1000 }], 10_000, 10);
    expect(shape[0]).toBeGreaterThan(0.3);
    expect(shape[9]).toBe(0.08);
  });
});
