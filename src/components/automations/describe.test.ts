import { describe, expect, it } from "vitest";
import { makeT } from "@/lib/i18n/core";
import { formatDate } from "@/lib/i18n/dates";
import en from "@/lib/i18n/messages/en/automations";
import da from "@/lib/i18n/messages/da/automations";
import { longDay, agoText, daysText, everyText, triggerText, whenText, type Copy } from "./describe";

const tz = "Europe/Copenhagen";
const now = new Date("2026-11-04T10:00:00Z"); // Wednesday
const copy = (locale: "en" | "da"): Copy => ({
  t: makeT(locale, { automations: locale === "da" ? da : en }, { automations: en }),
  fmt: (d, style) => formatDate(d, style, { locale, timeZone: tz, now }),
  timeZone: tz,
  locale,
  now,
});

describe("whenText", () => {
  it("says today, tomorrow and yesterday in both languages", () => {
    expect(whenText(copy("en"), "2026-11-04T17:00:00Z")).toBe("Today 18:00");
    expect(whenText(copy("en"), "2026-11-05T06:00:00Z", true)).toBe("tomorrow 07:00");
    expect(whenText(copy("da"), "2026-11-03T20:15:00Z")).toBe("I går 21.15");
  });
  it("uses the reader's zone, not the server's, for the day", () => {
    // 23:30 UTC on the 4th is already the 5th in Copenhagen.
    expect(whenText(copy("en"), "2026-11-04T23:30:00Z")).toBe("Tomorrow 00:30");
  });
  it("falls back to a dated time", () => {
    expect(whenText(copy("en"), "2026-11-08T17:00:00Z")).toMatch(/^Sun 8 Nov, 18:00$/);
    expect(whenText(copy("da"), "2026-11-08T17:00:00Z")).toBe("søn. 8. nov. kl. 18.00");
    expect(whenText(copy("en"), "2027-01-03T17:00:00Z")).toBe("Sun 3 Jan 2027, 18:00");
  });
});

describe("agoText", () => {
  it("is short for recent times", () => {
    expect(agoText(copy("en"), new Date(now.getTime() - 20_000))).toBe("just now");
    expect(agoText(copy("da"), new Date(now.getTime() - 12 * 60_000))).toBe("for 12 min. siden");
  });
});

describe("daysText and everyText", () => {
  it("names common day sets", () => {
    const t = copy("en").t;
    expect(daysText(t, [0, 1, 2, 3, 4, 5, 6], true)).toBe("Every day");
    expect(daysText(t, [1, 2, 3, 4, 5], true)).toBe("Weekdays");
    expect(daysText(t, [0], true)).toBe("Sundays");
    expect(daysText(t, [0, 1, 4], true)).toBe("Mondays, Thursdays and Sundays");
    expect(daysText(copy("da").t, [1, 3], false)).toBe("mandag og onsdag");
  });
  it("says how often", () => {
    const t = copy("en").t;
    expect(everyText(t, 60)).toBe("Every hour");
    expect(everyText(t, 120)).toBe("Every 2 hours");
    expect(everyText(t, 15)).toBe("Every 15 minutes");
    expect(everyText(copy("da").t, 1440)).toBe("Én gang om dagen");
  });
});

describe("triggerText", () => {
  it("describes schedules, check-ins and conditions", () => {
    const c = copy("en");
    expect(triggerText(c, { trigger: "schedule", config: { days: [0], time: "18:00", tz, date: null } })).toBe("Sundays at 18:00");
    expect(triggerText(c, { trigger: "heartbeat", config: { everyMinutes: 60, days: [1, 2, 3, 4, 5], from: "07:00", to: "20:00", tz } }))
      .toBe("Every hour, weekdays 07:00–20:00");
    expect(triggerText(c, { trigger: "condition", config: { check: "A document mentions a deadline", everyMinutes: 30, tz } }))
      .toBe("Every 30 minutes, when a document mentions a deadline");
    expect(triggerText(copy("da"), { trigger: "schedule", config: { days: [0], time: "18:00", tz, date: null } })).toBe("Søndage kl. 18:00");
  });
});

describe("longDay", () => {
  it("reads as a heading", () => {
    expect(longDay(new Date("2026-11-02T12:00:00Z"), "en", tz, now)).toBe("Monday 2 November");
    expect(longDay(new Date("2026-11-02T12:00:00Z"), "da", tz, now)).toBe("mandag 2. november");
  });
});
