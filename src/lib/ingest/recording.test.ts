import { describe, expect, it } from "vitest";
import type { ChangeInput } from "@/lib/changes";
import { chunkSegments } from "./chunk";
import { bestLine, dropGenericPeople, foldIntoMeeting, lineOfQuote, momentLink, recordingInfo, recordingOps, recordingSegments, refineReceipts } from "./recording";

const lines = [
  { a: 0, b: 5000, speaker: "Anna", text: "Thanks for coming. Tonight we decide on the class trip." },
  { a: 5000, b: 10_000, speaker: "Karen Holm", text: "The school pays the ferry, parents pay the hostel." },
  { a: 10_000, b: 15_000, speaker: "Mette Thomsen", text: "I will call the hostel tomorrow and ask about Thursday." },
  { a: 15_000, b: 20_000, speaker: "Speaker 4", text: "Who collects the money?" },
];
const info = recordingInfo({
  recording: {
    id: "rec_1", link: "https://rec.example/w/f/r/rec_1", tookPlace: "2026-10-28T16:00:00.000Z", durationMs: 20_000, summary: "Trip agreed.",
    people: ["Anna", "Karen Holm", "Mette Thomsen", "Ida"], decisions: ["The trip is Thursday to Saturday and parents pay the hostel."],
    todos: [{ id: "t1", text: "Call the hostel about Thursday", owner: "Mette Thomsen", due: "2026-10-29", done: false }, { id: "t2", text: "Old", owner: null, due: null, done: true }],
    speakers: [{ key: "anna", name: "Anna", email: null }, { key: "k", name: "Karen Holm", email: "karen@example.com" }, { key: "m", name: "Mette Thomsen", email: null }, { key: "s4", name: "Speaker 4", email: null }],
  },
})!;

let n = 0;
const mint = () => `id-${++n}`;

describe("a meeting in the reading pipeline", () => {
  it("makes one timed segment per line, and chunks keep the moment (ms) and speaker", () => {
    const segs = recordingSegments(lines);
    expect(segs[1]).toMatchObject({ text: "Karen Holm: The school pays the ferry, parents pay the hostel.", timeStartSec: 5, at: { time: 5000, speaker: "Karen Holm" } });
    const chunks = chunkSegments(segs, 80, 0);
    expect(chunks[0].locator).toMatchObject({ time: 0, speaker: "Anna", timeStartSec: 0 });
    expect(chunks.at(-1)!.locator.time).toBeGreaterThan(0);
  });

  it("links to Record at a moment", () => {
    expect(momentLink("https://rec.example/w/f/r/rec_1", 83_400)).toBe("https://rec.example/w/f/r/rec_1?t=83");
    expect(momentLink(null, 1)).toBeUndefined();
  });

  it("finds the line a quote or a decision came from", () => {
    expect(lineOfQuote("Karen Holm: The school pays the ferry", lines)).toBe(1);
    expect(lineOfQuote("call the hostel tomorrow", lines)).toBe(2);
    expect(bestLine("Call the hostel about Thursday", lines)).toBe(2);
    expect(bestLine("zzz qqq", lines)).toBe(-1);
  });

  it("proposes the meeting, its people (matched by email, then name), decisions and to-dos, each at its moment", () => {
    const known = [
      { id: "p-anna", type: "person", label: "Anna", aliases: [] },
      { id: "p-karen", type: "person", label: "K. Holm", aliases: [], email: "karen@example.com" },
    ];
    const plan = recordingOps({ info, title: "Parent meeting", sourceId: "s1", docNodeId: "doc1", eventNodeId: "ev1", eventExists: false, lines, known, existingEdges: new Set(), visibility: "household", mint });
    const ops = plan.changes;
    const event = ops.find((c) => c.op === "addNode" && c.type === "event");
    expect(event).toMatchObject({ nodeId: "ev1", label: "Parent meeting", startAt: "2026-10-28T16:00:00.000Z", endAt: "2026-10-28T16:00:20.000Z" });
    const people = ops.filter((c) => c.op === "addNode" && c.type === "person").map((c) => (c as { label: string }).label);
    expect(people).toEqual(["Mette Thomsen", "Ida"]); // Anna by name, Karen by email; Speaker 4 names nobody
    const involves = ops.filter((c) => c.op === "addEdge" && c.relation === "involves").map((c) => (c as { toId: string }).toId);
    expect(involves).toContain("p-anna");
    expect(involves).toContain("p-karen");
    const mette = ops.find((c) => c.op === "addNode" && c.label === "Mette Thomsen")!;
    expect(mette.receipt).toMatchObject({ sourceId: "s1", locator: { time: 10_000, speaker: "Mette Thomsen" }, url: "https://rec.example/w/f/r/rec_1?t=10" });
    expect(ops.find((c) => c.op === "addNode" && c.type === "topic")).toBeTruthy();
    const todo = ops.filter((c) => c.op === "addReminder");
    expect(todo).toHaveLength(1); // the done one is left out
    expect(todo[0]).toMatchObject({ title: "Mette Thomsen: Call the hostel about Thursday", dueAt: "2026-10-29T08:00:00.000Z" });
    expect((todo[0] as { aboutNodeId: string }).aboutNodeId).toBe((mette as { nodeId: string }).nodeId);
    expect(plan.known.map((k) => k.id)).toContain("ev1");
    expect(plan.edgeKeys.length).toBe(plan.counts.connections);
  });

  it("proposes nothing twice: an existing meeting and existing edges stay", () => {
    const known = [{ id: "p-anna", type: "person", label: "Anna", aliases: [] }];
    const plan = recordingOps({ info: { ...info, people: ["Anna"], speakers: [{ key: "a", name: "Anna", email: null }], decisions: [], todos: [] }, title: "M", sourceId: "s1", docNodeId: null, eventNodeId: "ev1", eventExists: true, lines, known, existingEdges: new Set(["ev1|involves|p-anna"]), visibility: "private", mint });
    expect(plan.changes).toEqual([]);
  });

  it("moves the reading's receipts to the line they quote, and drops 'Speaker 4' as a person", () => {
    const changes: ChangeInput[] = [
      { op: "addNode", nodeId: "x1", type: "place", label: "Hostel", receipt: { sourceId: "s1", quote: "parents pay the hostel", locator: { time: 0, timeStartSec: 0 } } },
      { op: "addNode", nodeId: "x2", type: "person", label: "Speaker 4", receipt: { sourceId: "s1" } },
      { op: "addEdge", fromId: "ev1", toId: "x2", relation: "involves" },
    ];
    refineReceipts(changes, "s1", info, lines);
    expect(changes[0].receipt).toMatchObject({ locator: { time: 5000, speaker: "Karen Holm" }, url: "https://rec.example/w/f/r/rec_1?t=5" });
    expect(dropGenericPeople(changes)).toBe(1);
    expect(changes).toHaveLength(1);
  });

  it("folds the reading's copy of the meeting into the meeting", () => {
    const changes: ChangeInput[] = [
      { op: "addNode", nodeId: "dup", type: "event", label: "Parent  meeting", startAt: "2026-11-04T00:00:00.000Z" },
      { op: "addEdge", fromId: "dup", toId: "p-anna", relation: "involves" },
      { op: "addEdge", fromId: "dup", toId: "p-bo", relation: "involves" },
      { op: "addEdge", fromId: "doc", toId: "dup", relation: "mentions" },
    ];
    foldIntoMeeting(changes, { title: "Parent meeting", eventNodeId: "ev1", edgeKeys: new Set(["ev1|involves|p-anna"]) });
    expect(changes).toEqual([
      { op: "addEdge", fromId: "ev1", toId: "p-bo", relation: "involves" },
      { op: "addEdge", fromId: "doc", toId: "ev1", relation: "mentions" },
    ]);
  });
});
