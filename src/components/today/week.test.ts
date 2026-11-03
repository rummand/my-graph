import { describe, expect, it } from "vitest";
import { buildWeek, displayTitle, dueLabel, humanizeDates, shortDay, weekDays, type Lane } from "./week";

const tz = "Europe/Copenhagen";
const now = new Date("2026-11-03T18:00:00Z"); // Tue 3 Nov, 19:00 in Copenhagen
const emma: Lane = { key: "u-emma", colorId: "n-emma", name: "Emma", href: null, age: null, personNodeId: "n-emma", userId: "u-emma" };
const family: Lane = { key: "family", colorId: null, name: "Whole family", href: null, age: null, personNodeId: null, userId: null };

describe("weekDays", () => {
  it("starts today and marks today and the weekend", () => {
    const days = weekDays(now, tz, 0);
    expect(days.map((d) => d.dayOfMonth)).toEqual([3, 4, 5, 6, 7, 8, 9]);
    expect(days[0].isToday).toBe(true);
    expect(days.filter((d) => d.isWeekend).map((d) => d.weekday)).toEqual(["Sat", "Sun"]);
    expect(weekDays(now, tz, 7)[0].isToday).toBe(false);
  });
});

describe("buildWeek", () => {
  it("puts events in each child's lane, spans days, and sends the rest to the family row", () => {
    const rows = buildWeek({
      lanes: [emma], family, now, tz, offset: 0,
      events: [
        { id: "e1", label: "Swimming", startAt: "2026-11-04T15:00:00Z", endAt: null, timePrecision: "minute", children: [{ userId: "u-emma" }] },
        { id: "e2", label: "Autumn break", startAt: "2026-11-05T23:00:00Z", endAt: "2026-11-08T23:00:00Z", timePrecision: "day", children: [] },
      ],
      reminders: [],
    });
    const [e, f] = rows;
    expect(e.items).toMatchObject([{ id: "e1", col: 1, span: 1, time: "16:00" }]);
    // Fri 6 to Sun 8 (the end at midnight belongs to the day before).
    expect(f.items).toMatchObject([{ id: "e2", col: 3, span: 3, time: null }]);
  });

  it("puts overdue reminders on today and notes what comes after the week", () => {
    const rows = buildWeek({
      lanes: [emma], family, now, tz, offset: 0, events: [],
      reminders: [
        { id: "r1", title: "Emma: Pay for trip", dueAt: "2026-11-01T09:00:00Z", done: false, aboutNodeId: "n-emma", aboutLabel: "Emma" },
        { id: "r2", title: "Book dentist", dueAt: "2026-11-20T09:00:00Z", done: false, aboutNodeId: null, aboutLabel: null },
        { id: "r3", title: "Done already", dueAt: "2026-11-04T09:00:00Z", done: true, aboutNodeId: "n-emma", aboutLabel: "Emma" },
      ],
    });
    expect(rows[0].items).toMatchObject([{ id: "r1", col: 0, overdue: true, label: "Pay for trip" }]);
    expect(rows[1].items).toEqual([]);
    expect(rows[1].next).toEqual({ label: "Book dentist", when: "Fri 20 Nov" });
  });
});

describe("copy helpers", () => {
  it("drops a name prefix the person chip already shows", () => {
    expect(displayTitle("Emma: Permission slip", "Emma")).toBe("Permission slip");
    expect(displayTitle("Emma: Permission slip", "Emma Jensen")).toBe("Permission slip");
    expect(displayTitle("Permission slip", null)).toBe("Permission slip");
  });

  it("spells out raw ISO dates and due times", () => {
    expect(humanizeDates("Coming up on 2026-11-16.", tz)).toBe("Coming up on Mon 16 Nov.");
    expect(shortDay(now, tz)).toBe("Tue 3 Nov");
    expect(dueLabel(new Date("2026-11-04T22:59:00Z"), now, tz)).toBe("by end of day");
    expect(dueLabel(new Date("2026-11-14T07:30:00Z"), now, tz)).toBe("Sat 14 Nov, 08:30");
  });
});
