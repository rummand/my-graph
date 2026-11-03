import { describe, expect, it } from "vitest";
import {
  addDaysInZone, ageLabel, ageThisYear, bucketFor, calendarDayDiff, dayKey, formatWhen, greetingFor, groupByBucket,
  hasTimeOfDay, startOfDayInZone, zonedTimeToUtc,
} from "./dates";

const TZ = "Europe/Copenhagen";

describe("Copenhagen day boundaries", () => {
  it("uses the local day, not the UTC day", () => {
    // 23:30 UTC on 3 Nov is 00:30 on 4 Nov in Copenhagen (UTC+1 in winter).
    expect(dayKey(new Date("2026-11-03T23:30:00Z"), TZ)).toBe("2026-11-04");
    expect(dayKey(new Date("2026-11-03T22:59:00Z"), TZ)).toBe("2026-11-03");
    // Summer: UTC+2.
    expect(dayKey(new Date("2026-07-01T22:30:00Z"), TZ)).toBe("2026-07-02");
  });

  it("finds local midnight", () => {
    expect(startOfDayInZone(new Date("2026-11-03T12:00:00Z"), TZ).toISOString()).toBe("2026-11-02T23:00:00.000Z");
    expect(startOfDayInZone(new Date("2026-07-01T12:00:00Z"), TZ).toISOString()).toBe("2026-06-30T22:00:00.000Z");
  });

  it("converts wall-clock time to UTC across DST", () => {
    expect(zonedTimeToUtc(2026, 3, 29, 8, 0, TZ).toISOString()).toBe("2026-03-29T06:00:00.000Z"); // after spring-forward
    expect(zonedTimeToUtc(2026, 3, 28, 8, 0, TZ).toISOString()).toBe("2026-03-28T07:00:00.000Z");
    expect(zonedTimeToUtc(2026, 10, 25, 8, 0, TZ).toISOString()).toBe("2026-10-25T07:00:00.000Z"); // after fall-back
  });

  it("keeps the wall-clock time when adding days over a DST change", () => {
    const sat8 = zonedTimeToUtc(2026, 3, 28, 8, 0, TZ);
    const sun = addDaysInZone(sat8, 1, TZ);
    expect(sun.toISOString()).toBe("2026-03-29T06:00:00.000Z"); // still 08:00 local
    expect(addDaysInZone(sat8, 7, TZ).toISOString()).toBe("2026-04-04T06:00:00.000Z");
  });

  it("counts calendar days, not 24h periods", () => {
    const now = new Date("2026-11-03T22:50:00Z"); // 23:50 Tue local
    expect(calendarDayDiff(new Date("2026-11-03T23:10:00Z"), now, TZ)).toBe(1); // 00:10 Wed local — 20 minutes away, tomorrow
  });
});

describe("bucketFor", () => {
  // Tuesday 3 Nov 2026, 10:00 local.
  const now = new Date("2026-11-03T09:00:00Z");
  const at = (iso: string) => bucketFor(new Date(iso), now, TZ);

  it("puts items in Overdue / Today / Tomorrow / This week / Later", () => {
    expect(at("2026-11-02T20:00:00Z")).toBe("overdue");
    expect(at("2026-11-03T08:00:00Z")).toBe("today"); // earlier today is still today
    expect(at("2026-11-03T22:30:00Z")).toBe("today"); // 23:30 local
    expect(at("2026-11-03T23:30:00Z")).toBe("tomorrow"); // 00:30 Wed local
    expect(at("2026-11-05T09:00:00Z")).toBe("week"); // Thursday
    expect(at("2026-11-08T21:00:00Z")).toBe("week"); // Sunday 22:00 local
    expect(at("2026-11-08T23:30:00Z")).toBe("later"); // Monday 00:30 local
  });

  it("on Saturday, Sunday is tomorrow and Monday is later", () => {
    const sat = new Date("2026-11-07T09:00:00Z");
    expect(bucketFor(new Date("2026-11-08T09:00:00Z"), sat, TZ)).toBe("tomorrow");
    expect(bucketFor(new Date("2026-11-09T09:00:00Z"), sat, TZ)).toBe("later");
  });

  it("on Sunday there is no 'this week'", () => {
    const sun = new Date("2026-11-08T09:00:00Z");
    expect(bucketFor(new Date("2026-11-10T09:00:00Z"), sun, TZ)).toBe("later");
  });
});

describe("groupByBucket", () => {
  it("groups in display order, sorts inside a group and drops empty groups", () => {
    const now = new Date("2026-11-03T09:00:00Z");
    const items = [
      { id: "later", at: "2026-11-20T09:00:00Z" },
      { id: "today-late", at: "2026-11-03T15:00:00Z" },
      { id: "today-early", at: "2026-11-03T07:00:00Z" },
      { id: "overdue", at: "2026-11-01T07:00:00Z" },
    ];
    const groups = groupByBucket(items, (i) => new Date(i.at), now, TZ);
    expect(groups.map((g) => g.label)).toEqual(["Overdue", "Today", "Later"]);
    expect(groups[1].items.map((i) => i.id)).toEqual(["today-early", "today-late"]);
  });

  it("returns nothing for no items", () => {
    expect(groupByBucket([], () => new Date(), new Date(), TZ)).toEqual([]);
  });
});

describe("ages", () => {
  const now = new Date("2026-11-03T09:00:00Z");
  it("gives the age reached this year", () => {
    expect(ageThisYear(2016, now, TZ)).toBe(10);
    expect(ageThisYear(2026, now, TZ)).toBe(0);
  });
  it("uses the local year on New Year's Eve night", () => {
    // 23:30 UTC on 31 Dec is already 1 Jan in Copenhagen.
    expect(ageThisYear(2016, new Date("2026-12-31T23:30:00Z"), TZ)).toBe(11);
  });
  it("returns null for unknown or implausible years", () => {
    expect(ageThisYear(null, now, TZ)).toBeNull();
    expect(ageThisYear(undefined, now, TZ)).toBeNull();
    expect(ageThisYear(2030, now, TZ)).toBeNull();
    expect(ageThisYear(1800, now, TZ)).toBeNull();
    expect(ageThisYear(2016.5, now, TZ)).toBeNull();
  });
  it("labels ages plainly", () => {
    expect(ageLabel(10)).toBe("10 this year");
    expect(ageLabel(0)).toBe("Born this year");
    expect(ageLabel(null)).toBeNull();
  });
});

describe("formatting", () => {
  const now = new Date("2026-11-03T09:00:00Z");
  it("says Today / Tomorrow / weekday with local time", () => {
    expect(formatWhen(new Date("2026-11-03T13:30:00Z"), now, TZ)).toBe("Today 14:30");
    expect(formatWhen(new Date("2026-11-04T07:00:00Z"), now, TZ)).toBe("Tomorrow 08:00");
    expect(formatWhen(new Date("2026-11-04T07:00:00Z"), now, TZ, false)).toBe("Tomorrow");
    expect(formatWhen(new Date("2026-11-06T07:00:00Z"), now, TZ, false)).toBe("Fri 6 Nov");
  });
  it("knows when a time of day is meaningful", () => {
    const localMidnight = new Date("2026-11-03T23:00:00Z");
    expect(hasTimeOfDay(localMidnight, null, TZ)).toBe(false);
    expect(hasTimeOfDay(localMidnight, "minute", TZ)).toBe(true);
    expect(hasTimeOfDay(new Date("2026-11-04T07:00:00Z"), "day", TZ)).toBe(false);
    expect(hasTimeOfDay(new Date("2026-11-04T07:00:00Z"), null, TZ)).toBe(true);
  });
  it("greets by local hour", () => {
    expect(greetingFor(new Date("2026-11-03T06:00:00Z"), TZ)).toBe("Good morning");
    expect(greetingFor(new Date("2026-11-03T13:00:00Z"), TZ)).toBe("Good afternoon");
    expect(greetingFor(new Date("2026-11-03T19:00:00Z"), TZ)).toBe("Good evening");
  });
});
