import { describe, expect, it } from "vitest";
import type { ImportKnown } from "@/lib/importers/types";
import { spondSnapshot } from "../spond/mapping";
import { EVENTS, GROUPS, PROFILE } from "../spond/testing/fixtures";
import { accountDraft, classify, eventDraft, eventFingerprint, narrow, pickTeams, type SportsSnapshot } from "./model";
import { eventOps, eventsTitle, membersOf, peopleOps, peopleTitle, placeKey, reminderDue, type PeopleInput } from "./ops";

const NOW = new Date("2026-11-05T12:00:00Z");
const snap = spondSnapshot(PROFILE, GROUPS, EVENTS);
const [ida, karl] = snap.members;

const person = (id: string, label: string, props: Record<string, unknown> = {}): ImportKnown => ({ id, type: "person", kind: "child", label, aliases: [], startAt: null, props });
const place = (id: string, label: string): ImportKnown => ({ id, type: "place", kind: null, label, aliases: [], startAt: null, props: {} });

function people(over: Partial<PeopleInput> = {}) {
  let n = 0;
  return peopleOps({
    snapshot: snap, locations: snap.events.flatMap((e) => (e.location ? [e.location] : [])), known: [], existing: new Set(), existingEdges: new Set(),
    mapping: {}, chosenNodeId: null, selfNodeId: "self-node", graphKind: "family", relations: new Set(["involves", "attends", "happened_at"]),
    kinds: new Set(["person:child", "place:sports_club", "event:activity"]), visibility: "parents", accountSourceId: "src-acc", webUrl: "https://spond.com/client/",
    now: NOW, mint: () => `new-${++n}`, ...over,
  });
}

describe("classify", () => {
  it.each([
    [{ title: "Træning" }, "training"], [{ title: "Fællestræning U10" }, "training"], [{ title: "Svømmestævne" }, "tournament"], [{ title: "Kampen i morgen" }, "match"], [{ title: "B93 vs. KB" }, "match"], [{ title: "Generalforsamling" }, "event"], [{ title: "Kamp mod KB" }, "match"],
    [{ title: "Stævne i Bellahøj" }, "tournament"], [{ title: "Dana Cup" }, "tournament"], [{ title: "Juleafslutning" }, "event"],
    [{ title: "B93 - KB", isMatch: true }, "match"], [{ type: "Træning", title: "Onsdag" }, "training"], [{ title: "Øvelse" }, "training"],
  ] as const)("%o → %s", (hints, kind) => expect(classify(hints)).toBe(kind));
});

describe("teams filter", () => {
  it("keeps the named teams (by name or id, any case) and their events and members", () => {
    expect(pickTeams(snap.teams, [])).toHaveLength(2);
    const s = narrow(snap, ["svømmeklubben delfinen"]);
    expect(s.teams.map((t) => t.id)).toEqual(["G-SWIM"]);
    expect(s.events.map((e) => e.id)).toEqual(["E-SWIM"]);
    expect(s.members.map((m) => [m.name, m.teamIds])).toEqual([["Ida Holm", ["G-SWIM"]], ["Karl Holm", ["G-SWIM"]]]);
    expect(narrow(snap, ["G-FOOT"]).members.map((m) => m.name)).toEqual(["Ida Holm"]);
  });
});

describe("sources", () => {
  it("an event's fingerprint moves with our answers and content, and its text says who answered what", () => {
    const e = snap.events[0];
    const fp = eventFingerprint(e);
    expect(eventFingerprint({ ...e, updated: "later" })).toBe(fp);
    expect(eventFingerprint({ ...e, responses: { [ida.key]: "accepted" } })).not.toBe(fp);
    expect(eventFingerprint({ ...e, start: new Date("2026-11-10T16:30:00Z") })).not.toBe(fp);
    const d = eventDraft(e, snap);
    expect(d.externalId).toBe("spond:event:E-TRAIN");
    expect(d.meta).toMatchObject({ kind: "calendar_event", noRead: true, cancelled: false });
    expect(d.text).toContain("Ida Holm: hasn't answered");
    expect(d.text).toContain("Where: Kunstgræsbanen, Peter Bangs Vej 147");
    expect(accountDraft(snap, "https://spond.com/client/").text).toContain("Child: Ida Holm, in B93 U10 piger, Svømmeklubben Delfinen");
  });
});

describe("people, teams and places", () => {
  it("proposes unknown children (family graph), the teams as sports clubs they attend, and the places", () => {
    const r = people();
    const adds = r.changes.filter((c) => c.op === "addNode");
    expect(adds.map((c) => c.op === "addNode" && [c.type, c.kind, c.label])).toEqual([
      ["person", "child", "Ida Holm"], ["person", "child", "Karl Holm"],
      ["place", "sports_club", "B93 U10 piger"], ["place", "sports_club", "Svømmeklubben Delfinen"],
      ["place", undefined, "Kunstgræsbanen"], ["place", undefined, "KB's anlæg"], ["place", undefined, "Bellahøj Svømmestadion"],
    ]);
    const edges = r.changes.filter((c) => c.op === "addEdge").map((c) => c.op === "addEdge" && `${c.fromId} ${c.relation} ${c.toId}`);
    expect(edges).toEqual(["new-1 attends new-3", "new-1 attends new-4", "new-2 attends new-4"]);
    expect(r.changes.every((c) => c.receipt?.sourceId === "src-acc")).toBe(true);
    expect(r.counts).toEqual({ people: 2, teams: 2, places: 3, connections: 3 });
    expect(peopleTitle(r.counts, "Spond")).toBe("2 children, 2 teams, 3 places, 3 connections from Spond");
    expect(r.mapping[`member:${ida.key}`].nodeId).toBe("new-1");
  });

  it("matches children by name and places by label, and doesn't propose anything twice", () => {
    const known = [person("n-ida", "Ida Holm", { birthDate: "2016-04-02" }), person("n-karl", "Karl Holm"), place("n-kunst", "Kunstgræsbanen")];
    const r = people({ known, existing: new Set(known.map((k) => k.id)) });
    expect(r.memberNodes.get(ida.key)).toBe("n-ida");
    expect(r.memberNodes.get(karl.key)).toBe("n-karl");
    expect(r.placeNodes.get(placeKey({ name: "Kunstgræsbanen", address: null, lat: null, lon: null })!)).toBe("n-kunst");
    expect(r.changes.some((c) => c.op === "addNode" && c.type === "person")).toBe(false);
    // Next run: the teams and places it proposed are still waiting; nothing new is proposed.
    const again = people({ known, existing: new Set(known.map((k) => k.id)), mapping: r.mapping });
    expect(again.changes).toEqual([]);
  });

  it("a birth date that disagrees stops a name match", () => {
    const r = people({ known: [person("n-ida", "Ida Holm", { birthDate: "2014-01-01" })] });
    expect(r.memberNodes.get(ida.key)).not.toBe("n-ida");
  });

  it("the person picked in the form is the child when there is one, or the one nobody recognised", () => {
    const one = { ...snap, members: [ida] };
    expect(people({ snapshot: one, chosenNodeId: "picked" }).memberNodes.get(ida.key)).toBe("picked");
    const r = people({ chosenNodeId: "picked", known: [person("n-karl", "Karl Holm")] });
    expect(r.memberNodes.get(ida.key)).toBe("picked");
    expect(r.memberNodes.get(karl.key)).toBe("n-karl");
    expect(r.changes.some((c) => c.op === "addNode" && c.type === "person")).toBe(false);
  });

  it("outside a family graph, unknown children are left out; the person signed in is themself", () => {
    const self: SportsSnapshot = { ...snap, members: [{ ...ida, relation: "self" }, karl] };
    const r = people({ snapshot: self, graphKind: "personal" });
    expect(r.memberNodes.get(ida.key)).toBe("self-node");
    expect(r.memberNodes.has(karl.key)).toBe(false);
    expect(r.changes.some((c) => c.op === "addNode" && c.type === "person")).toBe(false);
  });

  it("uses organizations and member_of when the graph's model has that relation", () => {
    const r = people({ relations: new Set(["involves", "member_of", "happened_at", "about"]) });
    const team = r.changes.find((c) => c.op === "addNode" && c.label === "B93 U10 piger");
    expect(team).toMatchObject({ type: "organization", kind: null });
    expect(r.changes.some((c) => c.op === "addEdge" && c.relation === "member_of")).toBe(true);
  });
});

describe("events", () => {
  const p = people();
  const base = (i: number, over: Record<string, unknown> = {}) => eventOps({
    e: snap.events[i], snapshot: snap, sourceId: `src-${i}`, nodeId: `ev-${i}`, nodeExists: false, changed: false,
    memberNodes: p.memberNodes, teamNodes: p.teamNodes, placeNodes: p.placeNodes, relations: new Set(["involves", "attends", "happened_at"]),
    kinds: new Set(["event:activity"]), visibility: "parents", reminded: new Set(), now: NOW, ...over,
  });

  it("a new training: the event, who it involves, the team, the place and a reminder to answer", () => {
    const r = base(0);
    expect(r.changes.map((c) => c.op)).toEqual(["addNode", "addEdge", "addEdge", "addEdge", "addReminder"]);
    expect(r.changes[0]).toMatchObject({ type: "event", kind: "activity", label: "Træning", startAt: "2026-11-10T16:00:00.000Z", props: { spondEventId: "E-TRAIN", sport: "training", team: "B93 U10 piger" } });
    expect(r.changes.slice(1, 4).map((c) => c.op === "addEdge" && `${c.relation} ${c.toId}`)).toEqual(["involves new-1", "involves new-3", "happened_at new-5"]);
    const rem = r.changes[4];
    expect(rem).toMatchObject({ op: "addReminder", title: "Answer in Spond: Træning (Ida Holm)", aboutNodeId: "new-1", dueAt: "2026-11-08T18:00:00.000Z" });
    expect(r.reminded).toEqual(["reminder:E-TRAIN:" + ida.key]);
    expect(r.changes.every((c) => c.receipt?.sourceId === "src-0" && c.receipt.url === "https://spond.com/client/sponds/E-TRAIN")).toBe(true);
  });

  it("doesn't remind twice, nor for what has started", () => {
    expect(base(0, { reminded: new Set([`reminder:E-TRAIN:${ida.key}`]) }).changes.some((c) => c.op === "addReminder")).toBe(false);
    expect(base(0, { now: new Date("2026-11-11T00:00:00Z") }).changes.some((c) => c.op === "addReminder")).toBe(false);
  });

  it("only our invited members are involved (the swim meet: both children; the match: Ida)", () => {
    expect(membersOf(snap.events[2], snap.members).map((m) => m.name)).toEqual(["Ida Holm", "Karl Holm"]);
    expect(membersOf(snap.events[1], snap.members).map((m) => m.name)).toEqual(["Ida Holm"]);
    const swim = base(2);
    expect(swim.changes.filter((c) => c.op === "addReminder").map((c) => c.op === "addReminder" && c.title)).toEqual(["Answer in Spond: Stævne i Bellahøj (Ida Holm)"]);
  });

  it("a change updates the node; a cancellation retires it; nothing to retire when it never landed", () => {
    const upd = base(1, { nodeExists: true, changed: true });
    expect(upd.changes).toHaveLength(1);
    expect(upd.changes[0]).toMatchObject({ op: "updateNode", nodeId: "ev-1", set: { label: "Kamp mod KB", props: { opponent: "KB U10", homeAway: "away" } } });
    expect(base(3, { nodeExists: true, changed: true }).changes.map((c) => c.op)).toEqual(["retireNode"]);
    expect(base(3).changes).toEqual([]);
    expect(base(1, { nodeExists: true, changed: false }).changes).toEqual([]);
  });

  it("reminder time stays between now and the start", () => {
    const e = snap.events[0];
    expect(reminderDue({ ...e, replyBy: null }, NOW).toISOString()).toBe("2026-11-08T16:00:00.000Z");
    expect(reminderDue(e, new Date("2026-11-09T12:00:00Z")).toISOString()).toBe("2026-11-09T12:00:00.000Z");
    expect(reminderDue({ ...e, replyBy: new Date("2026-11-12T00:00:00Z") }, NOW).toISOString()).toBe("2026-11-10T15:00:00.000Z");
  });

  it("titles say what's in the set", () => {
    expect(eventsTitle({ add: 3, update: 1, cancel: 0, remind: 2 }, "Holdsport")).toBe("3 new activities, 1 change, 2 replies to give from Holdsport");
  });
});
