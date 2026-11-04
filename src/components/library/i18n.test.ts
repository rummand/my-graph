import { describe, expect, it } from "vitest";
import { makeT, type Locale } from "@/lib/i18n/core";
import { DICTIONARIES } from "@/lib/i18n/messages";
import en from "@/lib/i18n/messages/en/library";
import da from "@/lib/i18n/messages/da/library";
import type { MessageTree } from "@/lib/i18n/core";
import { countsLine, dateOriginNote, extractionNote, formatBytes, formatDay, formatDocDate, kindWord, listJoin, senderName, timeOfDay, visibilityLabel, visibilityOptions, type Lx } from "./i18n";

const lx = (locale: Locale, family = false): Lx => ({
  t: makeT(locale, DICTIONARIES[locale], DICTIONARIES.en), locale, timeZone: "Europe/Copenhagen", family,
});

function keys(tree: MessageTree, prefix = ""): string[] {
  return Object.entries(tree).flatMap(([k, v]) =>
    typeof v === "string" || ("one" in v && "other" in v && typeof v.other === "string") ? [`${prefix}${k}`] : keys(v as MessageTree, `${prefix}${k}.`));
}

describe("library messages", () => {
  it("has Danish for every English key", () => {
    const missing = keys(en).filter((k) => !keys(da).includes(k));
    expect(missing).toEqual([]);
  });
});

describe("library wording", () => {
  it("uses family words only in a family graph", () => {
    expect(visibilityLabel(lx("en", true), "household")).toBe("Whole family");
    expect(visibilityLabel(lx("en"), "household")).toBe("Everyone");
    expect(visibilityLabel(lx("en"), "parents")).toBe("Editors");
    expect(visibilityOptions(lx("da", true)).map((o) => o.label)).toEqual(["Kun mig", "Forældre", "Hele familien"]);
    expect(visibilityOptions(lx("en")).some((o) => /family/i.test(o.hint))).toBe(false);
  });

  it("joins and counts in each language", () => {
    expect(listJoin(lx("en"), ["a", "b", "c"])).toBe("a, b and c");
    expect(listJoin(lx("da"), ["a", "b"])).toBe("a og b");
    expect(countsLine(lx("en"), { people: 1, events: 2 })).toBe("1 person and 2 dates");
    expect(countsLine(lx("da"), { people: 2, connections: 1 })).toBe("2 personer og 1 forbindelse");
    expect(countsLine(lx("da"), {})).toBe("intet nyt");
  });

  it("names kinds of file", () => {
    expect(kindWord(lx("en"), "letter", "pdf")).toBe("Letter");
    expect(kindWord(lx("da"), "nonsense", "audio")).toBe("Optagelse");
  });

  it("formats sizes with the reader's decimal mark", () => {
    expect(formatBytes(lx("en"), 1.5 * 1024 * 1024)).toBe("1.5 MB");
    expect(formatBytes(lx("da"), 1.5 * 1024 * 1024)).toBe("1,5 MB");
    expect(formatBytes(lx("en"), 12)).toBe("12 bytes");
  });

  it("formats document dates at their precision, as calendar dates", () => {
    expect(formatDocDate(lx("en"), "2024-03-03T00:00:00Z", "day")).toBe("3 Mar 2024");
    expect(formatDocDate(lx("en"), "2024-03-01T00:00:00Z", "month")).toBe("March 2024");
    expect(formatDocDate(lx("da"), "2024-03-01T00:00:00Z", "month")).toBe("marts 2024");
    expect(formatDocDate(lx("en"), "2024-01-01T00:00:00Z", "year")).toBe("2024");
    // 23:30 UTC is the next day in Copenhagen: an exact moment follows the reader's zone.
    expect(formatDocDate(lx("en"), "2024-03-03T23:30:00Z", "minute")).toBe("4 Mar 2024");
  });

  it("says today and yesterday in the reader's language", () => {
    const now = new Date("2026-11-04T12:00:00Z");
    expect(formatDay(lx("en"), "2026-11-04T08:00:00Z", now)).toBe("Today");
    expect(formatDay(lx("da"), "2026-11-03T08:00:00Z", now)).toBe("I går");
    expect(formatDay(lx("en"), "2026-10-20T08:00:00Z", now)).not.toMatch(/2026/);
  });

  it("only shows a time of day when there is one", () => {
    expect(timeOfDay(lx("en"), "2026-11-03T23:00:00Z")).toBeNull(); // midnight in Copenhagen
    expect(timeOfDay(lx("en"), "2026-11-03T13:05:00Z")).toBe("14:05");
  });

  it("explains extraction states and date origins", () => {
    expect(extractionNote(lx("en"), "done")).toBeNull();
    expect(extractionNote(lx("da"), "skipped: no text")).toMatch(/læsbar tekst/);
    expect(extractionNote(lx("en"), "failed: timeout")).toMatch(/timeout$/);
    expect(dateOriginNote(lx("en"), { origin: "email" })).toBe("From the email's sent date");
    expect(dateOriginNote(lx("da"), { origin: "text", quote: "Dato: 3/3" })).toBe("Fra datoen øverst i teksten: “Dato: 3/3”");
  });

  it("reads a sender's name", () => {
    expect(senderName('"Anna Holm" <anna@example.com>')).toBe("Anna Holm");
    expect(senderName(null)).toBeNull();
  });
});
