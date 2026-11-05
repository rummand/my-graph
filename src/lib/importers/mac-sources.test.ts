import { describe, expect, it } from "vitest";
import type { ChangeInput } from "@/lib/changes";
import { calendarImporter, inCalendarWindow, readCalendar } from "./calendar";
import { callsImporter, handleKey, readCalls } from "./calls";
import { importerById, importerForFile } from "./registry";
import { readReminders, reminderKey, remindersImporter } from "./reminders";
import { calendarPayload, callsPayload, remindersPayload, type CalendarPayload, type CallsPayload, type RemindersPayload } from "./schemas";
import type { ImportContext, ImportKnown } from "./types";

const NOW = new Date("2026-11-05T12:00:00Z");

function ctx(known: ImportKnown[] = [], extra: Partial<ImportContext> = {}): ImportContext {
  let n = 0;
  return { sourceId: "src", graphKind: "family", visibility: "private", known, existingEdges: new Set(), now: NOW, mint: () => `m${++n}`, locale: "en", selfNodeId: "me", ...extra };
}
const node = (id: string, type: string, label: string, props: Record<string, unknown> = {}, startAt: string | null = null): ImportKnown =>
  ({ id, type, kind: null, label, aliases: [], startAt, props });
const ops = (cs: ChangeInput[], op: string) => cs.filter((c) => c.op === op);

describe("calendar importer", () => {
  const ev = (id: string, start: string, extra: Partial<CalendarPayload["events"][number]> = {}) =>
    ({ id, calendar: "Family", title: `Event ${id}`, start, allDay: false, ...extra });

  it("is registered, JSON-only and checks the shape", () => {
    expect(importerById("calendar")).toBe(calendarImporter);
    expect(calendarImporter.detect({ filename: "calendar.json", head: new TextEncoder().encode('{"events":[]}') })).toBe(false);
    expect(importerForFile("calendar.json", new TextEncoder().encode('{"events":[]}'))?.id).not.toBe("calendar");
    expect(calendarPayload.safeParse({ events: [{ id: "a", calendar: "c", title: "t", start: "not a date", allDay: false }] }).success).toBe(false);
  });

  it("keeps 30 days back and 120 ahead", () => {
    expect(inCalendarWindow({ start: "2026-10-07T10:00:00+02:00" }, NOW)).toBe(true);
    expect(inCalendarWindow({ start: "2026-09-01T10:00:00+02:00" }, NOW)).toBe(false);
    expect(inCalendarWindow({ start: "2026-09-01T10:00:00+02:00", end: "2026-10-20T10:00:00+02:00" }, NOW)).toBe(true);
    expect(inCalendarWindow({ start: "2027-02-20T10:00:00+01:00" }, NOW)).toBe(true);
    expect(inCalendarWindow({ start: "2027-04-01T10:00:00+02:00" }, NOW)).toBe(false);
  });

  it("proposes events with people, places and the calendar's owner; skips what is known", () => {
    const known = [
      node("ida", "person", "Ida Hansen", { email: "ida@example.com" }),
      node("school", "place", "Skovbo Skole"),
      node("known-ev", "event", "Dentist", { macEventId: "E2" }, "2026-11-10T08:00:00.000Z"),
      node("same-ev", "event", "Parents' evening", {}, "2026-11-20T17:00:00.000Z"),
    ];
    const data: CalendarPayload = {
      events: [
        ev("E1", "2026-11-12T16:00:00+01:00", { title: "Football final", location: "Skovbo Skole, Køge", attendees: [{ name: "Ida", email: "IDA@example.com" }, { name: "Stranger", email: "x@y.z" }] }),
        ev("E2", "2026-11-10T09:00:00+01:00", { title: "Dentist" }), // known by Mac id, unchanged
        ev("E3", "2026-11-11T09:00:00+01:00", { title: "Dentist" }), // E2's id? no: a new event
        ev("E4", "2026-11-20T18:00:00+01:00", { title: "Parents' evening" }), // same name, same day: known
        ev("E5", "2026-01-01T09:00:00+01:00"), // outside the window
        ev("E1", "2026-11-12T16:00:00+01:00"), // duplicate id in the batch
      ],
    };
    const p = readCalendar(data, ctx(known));
    const adds = ops(p.changes, "addNode");
    expect(adds.map((c) => c.op === "addNode" && c.label).sort()).toEqual(["Dentist", "Football final"]);
    const football = adds.find((c) => c.op === "addNode" && c.label === "Football final")!;
    expect(football.op === "addNode" && football.props?.macEventId).toBe("E1");
    expect(football.receipt?.quote).toContain("Football final");
    const edges = ops(p.changes, "addEdge").map((c) => (c.op === "addEdge" ? `${c.relation}:${c.toId}` : ""));
    expect(edges).toContain("involves:me");
    expect(edges).toContain("involves:ida");
    expect(edges).toContain("happened_at:school");
    expect(edges.some((e) => e.includes("Stranger"))).toBe(false);
    expect(ops(p.changes, "addNode").filter((c) => c.op === "addNode" && c.type === "person")).toHaveLength(0);
    expect(p.counts).toMatchObject({ events: 2, known: 2, changed: 0 });
    expect(p.segments.map((s) => s.text).join("\n")).toContain("Football final");
  });

  it("proposes a change when a known event moved", () => {
    const known = [node("known-ev", "event", "Dentist", { macEventId: "E2" }, "2026-11-10T08:00:00.000Z")];
    const p = readCalendar({ events: [{ id: "E2", calendar: "Family", title: "Dentist", start: "2026-11-11T09:00:00+01:00", allDay: false }] }, ctx(known));
    expect(p.changes).toHaveLength(1);
    expect(p.changes[0]).toMatchObject({ op: "updateNode", nodeId: "known-ev" });
  });

  it("never floods: at most 300 events, the nearest first", () => {
    const events = Array.from({ length: 400 }, (_, i) => ev(`X${i}`, new Date(NOW.getTime() + (i + 1) * 3_600_000 * 6).toISOString()));
    const p = readCalendar({ events }, ctx([], { selfNodeId: null }));
    expect(ops(p.changes, "addNode")).toHaveLength(300);
    expect(p.warnings?.[0]).toContain("100 more");
    expect(p.changes.some((c) => c.op === "addNode" && c.props?.macEventId === "X0")).toBe(true);
  });
});

describe("reminders importer", () => {
  const rem = (id: string, extra: Partial<RemindersPayload["reminders"][number]> = {}) => ({ id, list: "Home", title: `Task ${id}`, done: false, ...extra });

  it("is private and JSON-only", () => {
    expect(importerById("reminders")).toBe(remindersImporter);
    expect(remindersImporter.privateOnly).toBe(true);
    expect(remindersPayload.safeParse({ reminders: [{ id: "a", list: "l", title: "t" }] }).success).toBe(false);
  });

  it("proposes open dated reminders only, once each", () => {
    const p = readReminders({
      reminders: [
        rem("R1", { title: "Buy gift for Ida", due: "2026-11-08T09:00:00+01:00", notes: "Lego" }),
        rem("R2", { title: "Call the plumber", done: true, due: "2026-11-01T09:00:00+01:00" }),
        rem("R3", { title: "Renew passport" }),
        rem("R4", { title: "Buy gift for Ida", due: "2026-11-08T10:00:00+01:00" }), // same title, same day
      ],
    }, ctx());
    expect(p.changes).toHaveLength(1);
    expect(p.changes[0]).toMatchObject({ op: "addReminder", title: "Buy gift for Ida", dueAt: "2026-11-08T08:00:00.000Z" });
    expect(p.changes[0].op === "addReminder" && p.changes[0].detail).toContain("in Reminders on your Mac.");
    expect(p.counts).toMatchObject({ reminders: 1, undated: 1, done: 1 });
    const text = p.segments.map((s) => s.text).join("\n");
    expect(text).toContain("Renew passport");
    expect(text).not.toContain("plumber");
  });

  it("keys reminders by title and due day", () => {
    expect(reminderKey("Buy  gift", "2026-11-08T09:00:00+01:00")).toBe(reminderKey("buy gift", "2026-11-08T08:00:00.000Z"));
    expect(reminderKey("Buy gift", null)).toBe("buy gift|");
  });
});

describe("calls importer", () => {
  const call = (id: string, at: string, handle: string, extra: Partial<CallsPayload["calls"][number]> = {}) =>
    ({ id, at, durationSec: 240, direction: "out" as const, handle, service: "phone" as const, ...extra });

  it("is sensitive, private and JSON-only", () => {
    expect(importerById("calls")).toBe(callsImporter);
    expect(callsImporter.sensitive && callsImporter.privateOnly).toBe(true);
    expect(callsPayload.safeParse({ calls: [{ id: "a", at: "2026-11-01T09:00:00Z", durationSec: 1, direction: "sideways", handle: "1", service: "phone" }] }).success).toBe(false);
  });

  it("logs per day and proposes only frequent named contacts", () => {
    const known = [node("mor", "person", "Mor", { phone: "+45 11 22 33 44" })];
    const data: CallsPayload = {
      calls: [
        call("c1", "2026-11-01T09:12:00+01:00", "004511223344"),
        call("c2", "2026-11-01T10:00:00+01:00", "+45 55 66 77 88", { name: "Karen Bager", direction: "in" }),
        call("c3", "2026-11-02T10:00:00+01:00", "55667788", { name: "Karen Bager" }),
        call("c4", "2026-11-03T18:30:00+01:00", "+4555667788", { name: "Karen Bager", direction: "missed" }),
        // A one-off number, and a frequent number with no name: never proposed.
        call("c5", "2026-11-03T19:00:00+01:00", "+45 99 99 99 99", { name: "Pizza place" }),
        call("c6", "2026-11-01T08:00:00+01:00", "+45 12 12 12 12"),
        call("c7", "2026-11-02T08:00:00+01:00", "+45 12 12 12 12"),
        call("c8", "2026-11-03T08:00:00+01:00", "+45 12 12 12 12"),
        // FaceTime by email, same day as c2.
        call("c9", "2026-11-01T20:00:00+01:00", "ida@example.com", { service: "facetime_video", durationSec: 30 }),
      ],
    };
    const p = readCalls(data, ctx(known));
    expect(p.counts).toMatchObject({ calls: 9, days: 3, people: 1, known: 1 });
    expect(p.changes).toHaveLength(1);
    expect(p.changes[0]).toMatchObject({ op: "addNode", type: "person", label: "Karen Bager", visibility: "private", sensitive: true });
    expect(p.changes[0].op === "addNode" && p.changes[0].props).toEqual({ phones: ["+45 55 66 77 88"] });
    const day1 = p.segments.find((s) => s.at?.region === "2026-11-01")!.text;
    expect(day1).toContain("Calls on 2026-11-01");
    expect(day1).toContain("09:12 Outgoing phone call to Mor (004511223344), 4 min");
    expect(day1).toContain("Outgoing FaceTime video call to ida@example.com, 30 s");
    expect(p.segments.find((s) => s.at?.region === "2026-11-03")!.text).toContain("Missed phone call from Karen Bager");
  });

  it("knows one handle in many spellings", () => {
    expect(handleKey("+45 55 66 77 88")).toBe(handleKey("004555667788"));
    expect(handleKey("Ida@Example.com ")).toBe("e:ida@example.com");
    expect(handleKey("12")).toBeNull();
  });
});
