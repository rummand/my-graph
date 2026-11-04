import { describe, expect, it } from "vitest";
import { locatorLabel, sourceHref } from "./labels";
import { locatorWords } from "@/components/chat/recency";

describe("links to where a fact came from", () => {
  it("opens a recording at the moment (seconds from locator.time in ms)", () => {
    expect(sourceHref("s1", { time: 83_400 })).toBe("/recordings/s1#t=83");
    expect(sourceHref("s1", { time: 0 })).toBe("/recordings/s1#t=0");
  });

  it("opens a document at its page, or in the library", () => {
    expect(sourceHref("s2", { page: 3 })).toBe("/library/s2#page=3");
    expect(sourceHref("s2", {})).toBe("/library/s2");
    expect(sourceHref("s2", null)).toBe("/library/s2");
    expect(sourceHref("s2", { time: Number.NaN })).toBe("/library/s2");
  });

  it("says the moment in words", () => {
    expect(locatorLabel({ time: 83_400 })).toBe("1:23");
    expect(locatorWords({ time: 83_400 })).toContain("1:23");
  });
});
