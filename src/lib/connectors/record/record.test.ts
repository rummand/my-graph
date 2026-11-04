import { describe, expect, it } from "vitest";
import { validateManifest } from "../manifest";
import { approvalToken, approvalValid, spendApproval } from "../mcp/hook";
import { enabledTools } from "../mcp/config";
import { audioFrom, makeLimiter, mayPlay, passStatus, proxyHeaders, rangeToForward, reuseUntil, type PlayableSource } from "./audio-proxy";
import { capabilitiesOf, planMeetings, recordManifest } from "./connector";
import {
  estimateWords, listFingerprint, meetingDetail, meetingsFromList, meetingToSource, parseTranscript, stampMs, timelineFrom, timelineFromTranscript, transcriptText,
} from "./mapping";

const listResult = {
  meetings: [
    { id: "rec_1", workspace: "Family", title: "Parent meeting", tookPlace: "2026-10-28T16:00:00.000Z", durationMs: 31703, status: "Ready", summary: "Trip agreed.", link: "https://rec.example/w/f/r/rec_1", updatedAt: "2026-10-28T17:00:00.000Z" },
    { id: "bad id!", title: "x" },
    { id: "rec_2", title: "No link", tookPlace: "nonsense", link: "javascript:alert(1)" },
  ],
};

const meeting = {
  id: "rec_1", title: "Parent meeting", tookPlace: "2026-10-28T16:00:00.000Z", durationMs: 31703, link: "https://rec.example/w/f/r/rec_1",
  status: "Ready", recordedBy: "Anna", people: ["Anna", "Karen Holm"], tags: ["school"], summary: "Trip agreed.",
  decisions: ["The trip is Thursday to Saturday."], sections: [{ title: "Trip", text: "Bornholm" }],
  todos: [{ id: "t1", text: "Call the hostel", owner: "Karen Holm", due: "2026-10-29", done: false }, { id: "t2", text: "x", owner: null, due: "soon", done: true }],
  transcript: "[0:00] Anna: Thanks for coming.\n[0:05] Karen Holm: The school pays the ferry.\nand the rest of it\n[1:02:03] Anna: Good.",
};

describe("Record meeting → source", () => {
  it("reads list_meetings, dropping bad ids and unsafe links", () => {
    const list = meetingsFromList(listResult);
    expect(list.map((m) => m.id)).toEqual(["rec_1", "rec_2"]);
    expect(list[1]).toMatchObject({ title: "No link", tookPlace: null, link: null });
    expect(listFingerprint(list[0])).toMatch(/^[0-9a-f]{32}$/);
  });

  it("parses Record's transcript lines with times and speakers", () => {
    expect(stampMs("1:02:03")).toBe(3_723_000);
    const lines = parseTranscript(meeting.transcript, 3_730_000);
    expect(lines.map((l) => [l.a, l.speaker])).toEqual([[0, "Anna"], [5000, "Karen Holm"], [3_723_000, "Anna"]]);
    expect(lines[1].text).toBe("The school pays the ferry. and the rest of it");
    expect(lines[0].b).toBe(5000);
    expect(lines[2].b).toBe(3_730_000);
  });

  it("spreads words over a line by length when Record gives no word times", () => {
    const w = estimateWords([{ a: 0, b: 1000, text: "a bbb" }]);
    expect(w).toEqual([{ a: 0, b: 333, w: "a", line: 0 }, { a: 333, b: 1000, w: "bbb", line: 0 }]);
  });

  it("reads get_meeting_timeline (words, lines, speakers by name or index)", () => {
    const tl = timelineFrom({
      durationMs: 9000,
      words: [{ a: 0, b: 400, w: "Hello", line: 0 }, { a: 500, b: 900, w: "there.", line: 0 }, { a: 1000, b: 1600, w: "Hi!", line: 1 }],
      lines: [{ a: 0, b: 900, speaker: "Anna", first: 0, last: 1 }, { a: 1000, b: 1600, speaker: 1, first: 2, last: 2 }],
      speakers: [{ name: "Anna", email: "ANNA@example.com" }, { name: "Bo" }],
    })!;
    expect(tl.timing).toBe("exact");
    expect(tl.lines.map((l) => [l.speaker, l.text])).toEqual([["Anna", "Hello there."], ["Bo", "Hi!"]]);
    expect(tl.speakers[0]).toEqual({ key: "Anna", name: "Anna", email: "anna@example.com" });
    expect(tl.durationMs).toBe(9000);
    expect(timelineFrom({ words: [] })).toBeNull();
  });

  it("maps a meeting to a recording source with Record's link, the day it was recorded and a time per line", () => {
    const d = meetingDetail(meeting)!;
    expect(d.todos[1].due).toBeNull();
    const tl = timelineFromTranscript(d.transcript, d.durationMs, d.people);
    const row = meetingToSource(d, tl, { listFingerprint: "abc", server: "https://rec.example/api/mcp" });
    expect(row).toMatchObject({ externalId: "record:rec_1", title: "Parent meeting", url: "https://rec.example/w/f/r/rec_1" });
    expect(row.documentDate?.toISOString()).toBe("2026-10-28T16:00:00.000Z");
    expect(row.textContent.split("\n")[1]).toBe("[0:05] Karen Holm: The school pays the ferry. and the rest of it");
    const rec = row.meta.recording as Record<string, unknown>;
    expect(rec).toMatchObject({ id: "rec_1", link: "https://rec.example/w/f/r/rec_1", decisions: ["The trip is Thursday to Saturday."], timing: "estimated" });
    expect(row.meta).toMatchObject({ kind: "recording", listFingerprint: "abc" });
    expect(transcriptText([{ a: 65_000, speaker: null, text: "x" }])).toBe("[1:05] x");
  });

  it("knows what Record's tools make possible, and plans which meetings to read", () => {
    const caps = capabilitiesOf([{ name: "list_meetings", inputSchema: { properties: { updated_since: {} } } }, { name: "get_meeting_audio", inputSchema: null }]);
    expect(caps).toEqual({ timeline: false, audio: true, people: false, person: false, updatedSince: true });
    const list = meetingsFromList(listResult);
    const known = new Map([["record:rec_1", listFingerprint(list[0])]]);
    expect(planMeetings(list, known, "newest").take.map((m) => m.id)).toEqual(["rec_2"]);
    expect(planMeetings(list, new Map(), "newest", 1)).toMatchObject({ more: true });
    expect(validateManifest(recordManifest)).toEqual({ ok: true });
  });
});

describe("tools a graph allows, and approvals", () => {
  it("turns on read-only tools until a person chooses", () => {
    const tools = [{ name: "list", writes: false }, { name: "add_todo", writes: true }];
    expect(enabledTools({ tools, allowedTools: [], toolsChosen: false })).toEqual(["list"]);
    expect(enabledTools({ tools, allowedTools: ["add_todo"], toolsChosen: true })).toEqual(["add_todo"]);
  });

  it("an approval is bound to the person, connection, tool, exact arguments and time", () => {
    const base = { userId: "u1", graphId: "g1", connectionId: "c1", tool: "complete_todo", args: { id: "t1", done: true } };
    const token = approvalToken({ ...base, expiresAt: Date.now() + 60_000 });
    expect(approvalValid(token, { ...base, args: { done: true, id: "t1" } })).toBe(true); // key order doesn't matter
    expect(approvalValid(token, { ...base, args: { id: "t2", done: true } })).toBe(false);
    expect(approvalValid(token, { ...base, userId: "u2" })).toBe(false);
    expect(approvalValid(token, { ...base, tool: "add_todo" })).toBe(false);
    expect(approvalValid(token, base, Date.now() + 120_000)).toBe(false);
    expect(approvalValid(token.replace(/.$/, (c) => (c === "A" ? "B" : "A")), base)).toBe(false);
  });

  it("an approval runs its call once", () => {
    const base = { userId: "u1", graphId: "g1", connectionId: "c1", tool: "complete_todo", args: { id: "t9" } };
    const token = approvalToken({ ...base, expiresAt: Date.now() + 60_000 });
    expect(spendApproval(token)).toBe(true);
    expect(spendApproval(token)).toBe(false);
    expect(spendApproval(approvalToken({ ...base, expiresAt: Date.now() + 60_001 }))).toBe(true);
  });
});

describe("the audio proxy", () => {
  const viewer = { id: "u-anna", householdId: "h1", graphId: "g1", role: "owner", graphRole: "owner", graphKind: "family", graphHouseholdId: "h1" } as never;
  const child = { id: "u-kid", householdId: "h1", graphId: "g1", role: "child", graphRole: "viewer", graphKind: "family", graphHouseholdId: "h1" } as never;
  const src = (o: Partial<PlayableSource> = {}): PlayableSource => ({
    ownerId: "u-mikkel", householdId: "h1", visibility: "household", sensitive: false, graphId: "g1", kind: "recording", connectionId: "c1", externalId: "record:rec_1", ...o,
  });

  it("checks access on the recording itself", () => {
    expect(mayPlay(viewer, src())).toBe(true);
    expect(mayPlay(viewer, src({ visibility: "private" }))).toBe(false);
    expect(mayPlay(viewer, src({ visibility: "private" }), true)).toBe(true); // shared with them
    expect(mayPlay(viewer, src({ graphId: "g2" }))).toBe(false);
    expect(mayPlay(child, src({ sensitive: true }))).toBe(false);
    expect(mayPlay(viewer, src({ kind: "upload" }))).toBe(false);
    expect(mayPlay(viewer, src({ connectionId: null }))).toBe(false);
    expect(mayPlay(viewer, null)).toBe(false);
  });

  it("passes one byte range through and nothing else", () => {
    expect(rangeToForward("bytes=0-1023")).toBe("bytes=0-1023");
    expect(rangeToForward("bytes=500-")).toBe("bytes=500-");
    expect(rangeToForward("bytes=-500")).toBe("bytes=-500");
    expect(rangeToForward("bytes=0-1,5-9")).toBeNull();
    expect(rangeToForward("bytes=9-1")).toBeNull();
    expect(rangeToForward("items=0-1")).toBeNull();
    expect(rangeToForward(null)).toBeNull();
    expect(passStatus(206)).toBe(true);
    expect(passStatus(416)).toBe(true);
    expect(passStatus(302)).toBe(false);
  });

  it("keeps the range headers, refuses what isn't sound, and never leaks the upstream address", () => {
    const h = proxyHeaders({ "content-type": "audio/wav", "content-range": "bytes 0-1/100", "content-length": "2", location: "https://secret", "set-cookie": "a=b", "x-amz-request-id": "x" })!;
    expect(h).toMatchObject({ "content-type": "audio/wav", "content-range": "bytes 0-1/100", "content-length": "2", "cache-control": "private, no-store", "accept-ranges": "bytes" });
    expect(h.location).toBeUndefined();
    expect(h["set-cookie"]).toBeUndefined();
    expect(proxyHeaders({ "content-type": "text/html" })).toBeNull();
  });

  it("reuses a signed address only while it is valid, and at most 10 minutes", () => {
    const now = 1_000_000;
    expect(reuseUntil(new Date(now + 5 * 60_000).toISOString(), now)).toBe(now + 5 * 60_000 - 15_000);
    expect(reuseUntil(now + 3_600_000, now)).toBe(now + 600_000);
    expect(reuseUntil(null, now)).toBe(now + 60_000);
    expect(audioFrom({ url: "https://a/x.wav?sig=1", expiresAt: "2026-01-01T00:00:00Z", peaks: [0.1, 2, -1] })).toMatchObject({ url: "https://a/x.wav?sig=1", peaks: [0.1, 1, 0] });
    expect(audioFrom({ url: "file:///etc/passwd" })).toBeNull();
    expect(audioFrom({ audio: { url: "https://a/b" }, peaks: { durationMs: 5, peaks: [0.5] } })).toMatchObject({ url: "https://a/b", peaks: [0.5], durationMs: 5 });
  });

  it("limits requests per person per minute", () => {
    const allow = makeLimiter(2);
    expect([allow("a", 0), allow("a", 1), allow("a", 2), allow("b", 2), allow("a", 60_001)]).toEqual([true, true, false, true, true]);
  });
});
