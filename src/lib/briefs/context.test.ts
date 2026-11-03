import { describe, expect, it } from "vitest";
import { buildAgenda } from "./agenda";
import { buildBriefContext, buildBriefMessages, humanizeRelation, pickCitations, splitCitations, type BriefInput } from "./context";

const TZ = "Europe/Copenhagen";
const now = new Date("2026-11-03T09:00:00Z"); // Tue 10:00 local

function input(over: Partial<BriefInput> = {}): BriefInput {
  return {
    now, tz: TZ, viewerName: "Anna", children: [{ name: "Emma", age: 9 }],
    events: [], reminders: [], facts: [], failedUploads: [], ...over,
  };
}

describe("buildBriefContext", () => {
  it("is empty when there is nothing to say", () => {
    const ctx = buildBriefContext(input());
    expect(ctx.empty).toBe(true);
    expect(ctx.citations).toEqual([]);
  });

  it("numbers events, then reminders, then facts, and maps numbers back to citations", () => {
    const ctx = buildBriefContext(input({
      events: [
        { id: "e2", label: "Swimming", startAt: new Date("2026-11-05T15:00:00Z"), timePrecision: "minute", people: ["Emma"], sensitive: false },
        { id: "e1", label: "Field trip to Zoo", startAt: new Date("2026-11-04T07:00:00Z"), timePrecision: "minute", summary: "Bring packed lunch", people: ["Emma"], sensitive: false },
      ],
      reminders: [{ id: "r1", title: "Sign trip form", detail: null, dueAt: new Date("2026-11-03T18:00:00Z"), about: "Emma", nodeId: null, sourceId: "s9" }],
      facts: [{ edgeId: "x1", fromId: "n1", text: "Emma attends Ørestad Skole", confidence: 0.42, sourceId: "s1", sourceTitle: "Aula letter", quote: "Emma i 3.B", sensitive: false }],
    }));
    expect(ctx.empty).toBe(false);
    expect(ctx.sensitive).toBe(false);
    expect(ctx.citations.map((c) => [c.n, c.title])).toEqual([
      [1, "Field trip to Zoo"], [2, "Swimming"], [3, "Sign trip form"], [4, "Aula letter"],
    ]);
    expect(ctx.citations[0].nodeId).toBe("e1");
    expect(ctx.citations[2].sourceId).toBe("s9");
    expect(ctx.citations[3]).toMatchObject({ edgeId: "x1", sourceId: "s1", confidence: 0.42, quote: "Emma i 3.B" });
    expect(ctx.text).toContain("[1] Tomorrow 08:00 (tomorrow) · Field trip to Zoo · involves Emma — Bring packed lunch");
    expect(ctx.text).toContain("[3] Due Today 19:00 (today) · Sign trip form · about Emma");
    expect(ctx.text).toContain("confidence 0.42");
  });

  it("leaves out events and reminders beyond the 7-day horizon and events that already ended", () => {
    const ctx = buildBriefContext(input({
      events: [
        { id: "far", label: "Far away", startAt: new Date("2026-11-20T09:00:00Z"), timePrecision: "day", people: [], sensitive: false },
        { id: "past", label: "Yesterday", startAt: new Date("2026-11-02T09:00:00Z"), timePrecision: "day", people: [], sensitive: false },
      ],
      reminders: [{ id: "r", title: "Next month", detail: null, dueAt: new Date("2026-12-03T09:00:00Z"), about: null, nodeId: null, sourceId: null }],
    }));
    expect(ctx.empty).toBe(true);
  });

  it("keeps overdue reminders and says so", () => {
    const ctx = buildBriefContext(input({
      reminders: [{ id: "r", title: "Pay school milk", detail: null, dueAt: new Date("2026-11-01T09:00:00Z"), about: null, nodeId: null, sourceId: null }],
    }));
    expect(ctx.text).toContain("overdue by 2 days");
  });

  it("flags sensitive context so mux stays local", () => {
    const ctx = buildBriefContext(input({
      events: [{ id: "d", label: "Doctor", startAt: new Date("2026-11-04T09:00:00Z"), timePrecision: "minute", people: [], sensitive: true }],
    }));
    expect(ctx.sensitive).toBe(true);
  });

  it("mentions failed uploads without citing them", () => {
    const ctx = buildBriefContext(input({ failedUploads: [{ id: "f", title: "scan.pdf" }] }));
    expect(ctx.empty).toBe(false);
    expect(ctx.citations).toEqual([]);
    expect(ctx.text).toContain('Uploads that could not be read: 1 ("scan.pdf")');
  });

  it("builds a system + user prompt with the date and children", () => {
    const i = input({ events: [{ id: "e", label: "Trip", startAt: new Date("2026-11-04T07:00:00Z"), timePrecision: "minute", people: [], sensitive: false }] });
    const msgs = buildBriefMessages(i, buildBriefContext(i));
    expect(msgs.map((m) => m.role)).toEqual(["system", "user"]);
    expect(msgs[1].content).toContain("Tuesday, 3 November 2026");
    expect(msgs[1].content).toContain("Emma (9 this year)");
    expect(msgs[1].content).toContain("[1]");
  });
});

describe("pickCitations", () => {
  const cits = [{ n: 1, title: "Trip" }, { n: 2, title: "Form" }, { n: 3, title: "Unused" }];
  it("keeps used citations in number order and removes unknown markers", () => {
    const out = pickCitations("Tomorrow: trip — pack lunch [1] [7].\nToday: sign form [2] .", cits);
    expect(out.text).toBe("Tomorrow: trip — pack lunch [1].\nToday: sign form [2].");
    expect(out.citations.map((c) => c.n)).toEqual([1, 2]);
  });
  it("collapses blank-line runs", () => {
    expect(pickCitations("a [2]\n\n\n\nb [1]", cits).text).toBe("a [2]\n\nb [1]");
  });
});

describe("splitCitations", () => {
  it("splits text and markers", () => {
    expect(splitCitations("Pack lunch [1], sign [2]")).toEqual([
      { kind: "text", text: "Pack lunch " }, { kind: "cite", n: 1 }, { kind: "text", text: ", sign " }, { kind: "cite", n: 2 },
    ]);
  });
});

describe("humanizeRelation", () => {
  it("turns snake_case into words", () => expect(humanizeRelation("parent_of")).toBe("parent of"));
});

describe("buildAgenda", () => {
  it("merges events and reminders into buckets; multi-day events that started earlier show as today", () => {
    const groups = buildAgenda(
      [
        { id: "camp", startAt: "2026-11-01T08:00:00Z", endAt: "2026-11-05T15:00:00Z" },
        { id: "gone", startAt: "2026-11-01T08:00:00Z", endAt: null },
        { id: "trip", startAt: "2026-11-04T07:00:00Z", endAt: null },
      ],
      [
        { id: "late", dueAt: "2026-11-01T08:00:00Z", done: false },
        { id: "ticked", dueAt: "2026-11-01T08:00:00Z", done: true },
        { id: "form", dueAt: "2026-11-03T18:00:00Z", done: false },
      ],
      now, TZ,
    );
    const shape = groups.map((g) => [g.bucket, g.items.map((i) => (i.kind === "event" ? i.event.id : i.reminder.id))]);
    expect(shape).toEqual([
      ["overdue", ["late"]],
      ["today", ["camp", "ticked", "form"]],
      ["tomorrow", ["trip"]],
    ]);
  });
});
