import { describe, expect, it } from "vitest";
import { attentionTotal, firstNameOf, groupWeek } from "./shape";

const end = new Date("2026-11-11T00:00:00Z");
const ev = (id: string, start: string, personIds: string[], precision: string | null = "minute") =>
  ({ id, kind: "event", title: id, start, precision, personIds, nodeId: `n-${id}`, sourceId: null });

describe("groupWeek", () => {
  it("puts events on each person's row in people order, the shared row last", () => {
    const g = groupWeek({
      items: [ev("swim", "2026-11-05T15:00:00Z", ["emma"]), ev("dinner", "2026-11-04T17:00:00Z", []), ev("both", "2026-11-06T09:00:00Z", ["emma", "noah"])],
      reminders: [],
      people: [{ id: "noah", label: "Noah" }, { id: "emma", label: "Emma" }],
      end, everyoneLabel: "Whole family",
    });
    expect(g.map((x) => x.name)).toEqual(["Noah", "Emma", "Whole family"]);
    expect(g[1].entries.map((e) => e.id)).toEqual(["swim", "both"]);
    expect(g[2].personId).toBeNull();
  });

  it("adds open reminders due before the end, about a known person or on the shared row", () => {
    const g = groupWeek({
      items: [],
      reminders: [
        { id: "1", title: "Pack", dueAt: "2026-11-05T07:00:00Z", done: false, aboutNodeId: "emma", nodeId: null, sourceId: null },
        { id: "2", title: "Done", dueAt: "2026-11-05T07:00:00Z", done: true, aboutNodeId: "emma", nodeId: null, sourceId: null },
        { id: "3", title: "Later", dueAt: "2026-11-20T07:00:00Z", done: false, aboutNodeId: null, nodeId: null, sourceId: null },
        { id: "4", title: "Stranger", dueAt: new Date("2026-11-06T07:00:00Z"), done: false, aboutNodeId: "zed", nodeId: null, sourceId: "s" },
      ],
      people: [{ id: "emma", label: "Emma" }],
      end, everyoneLabel: "Everything",
    });
    expect(g).toHaveLength(2);
    expect(g[0].entries[0]).toMatchObject({ id: "r:1", reminderId: "1", isReminder: true });
    expect(g[1]).toMatchObject({ name: "Everything", entries: [{ id: "r:4", sourceId: "s" }] });
  });

  it("marks day-precision events as all day and sorts by time", () => {
    const g = groupWeek({ items: [ev("b", "2026-11-06T10:00:00Z", []), ev("a", "2026-11-05T00:00:00Z", [], "day")], reminders: [], people: [], end, everyoneLabel: "All" });
    expect(g[0].entries.map((e) => [e.id, e.allDay])).toEqual([["a", true], ["b", false]]);
  });
});

describe("small helpers", () => {
  it("firstNameOf", () => {
    expect(firstNameOf("Anna Hansen")).toBe("Anna");
    expect(firstNameOf("")).toBe("");
  });
  it("attentionTotal treats missing parts as zero", () => {
    expect(attentionTotal({ facts: 2, failedUploads: null, duplicates: 1 })).toBe(3);
  });
});
