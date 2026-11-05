import { describe, expect, it } from "vitest";
import {
  countLedger, daysUntil, filterPerson, filterTab, forViewer, groupByDirection, groupByPerson, groupByUrgency, matchReminder, moveFingerprint,
  nextOccurrence, onlyReadable, planReminder, readProps, reminderDueAt, rollForwardOps, urgencyOf, type CommitmentView,
} from "./pure";
import { commitmentOps } from "./ops";
import type { CommitmentProps } from "./types";

const TZ = "Europe/Copenhagen";
// Wednesday 5 November 2026, 10:00 in Copenhagen.
const NOW = new Date("2026-11-05T09:00:00Z");
const day = (n: number, hour = 12) => new Date(Date.UTC(2026, 10, 5 + n, hour - 1)).toISOString();

const props = (p: Partial<CommitmentProps> = {}): CommitmentProps => ({
  direction: "owe", status: "open", kind: "payment", dueAt: day(10), dueKind: "deadline", ...p,
});

let n = 0;
const view = (p: Partial<CommitmentProps> = {}, extra: Partial<CommitmentView> = {}): CommitmentView => ({
  id: `c${++n}`, label: `Commitment ${n}`, summary: null, props: props(p), ownerId: "u1", visibility: "household", sensitive: false,
  responsible: [], counterparty: [], about: [], arisesFrom: [], clashes: [], sources: [], reminder: null, canEdit: true,
  createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", ...extra,
});

describe("days", () => {
  it("counts calendar days where the household lives, not 24-hour blocks", () => {
    expect(daysUntil(day(0, 23), NOW, TZ)).toBe(0);
    expect(daysUntil("2026-11-05T23:30:00Z", NOW, TZ)).toBe(1); // 00:30 on the 6th in Copenhagen
    expect(daysUntil(day(-1), NOW, TZ)).toBe(-1);
  });
});

describe("urgency", () => {
  it("overdue once its day has passed, not earlier the same day", () => {
    expect(urgencyOf(props({ dueAt: day(-1) }), NOW, TZ)).toBe("overdue");
    expect(urgencyOf(props({ dueAt: day(0, 8), kind: "appointment" }), NOW, TZ)).toBe("this_week");
  });
  it("at risk inside its lead time with nothing done about it", () => {
    expect(urgencyOf(props({ kind: "payment", dueAt: day(2) }), NOW, TZ)).toBe("at_risk"); // payment lead 3
    expect(urgencyOf(props({ kind: "payment", dueAt: day(5) }), NOW, TZ)).toBe("this_week");
    expect(urgencyOf(props({ kind: "notice", dueAt: day(12) }), NOW, TZ)).toBe("at_risk"); // notice lead 14
    expect(urgencyOf(props({ kind: "renewal", dueAt: day(25) }), NOW, TZ)).toBe("at_risk"); // renewal lead 30
    expect(urgencyOf(props({ kind: "payment", dueAt: day(2), leadDays: 1 }), NOW, TZ)).toBe("this_week");
  });
  it("progress or a snooze takes it out of at risk; a snooze that has run out does not", () => {
    expect(urgencyOf(props({ dueAt: day(2), progressAt: day(-1) }), NOW, TZ)).toBe("this_week");
    expect(urgencyOf(props({ dueAt: day(2), snoozedUntil: day(1) }), NOW, TZ)).toBe("this_week");
    expect(urgencyOf(props({ dueAt: day(2), snoozedUntil: day(-1) }), NOW, TZ)).toBe("at_risk");
  });
  it("appointments are never at risk on their own", () => {
    expect(urgencyOf(props({ kind: "appointment", dueAt: day(1) }), NOW, TZ)).toBe("this_week");
  });
  it("later, undated, and nothing for closed ones", () => {
    expect(urgencyOf(props({ kind: "payment", dueAt: day(20) }), NOW, TZ)).toBe("later");
    expect(urgencyOf(props({ dueAt: null }), NOW, TZ)).toBe("undated");
    expect(urgencyOf(props({ status: "done", dueAt: day(-3) }), NOW, TZ)).toBeNull();
    expect(urgencyOf(props({ status: "cancelled" }), NOW, TZ)).toBeNull();
  });
});

describe("reading props", () => {
  it("falls back safely and takes the date from startAt and the kind from the node", () => {
    const p = readProps({ direction: "sideways", amount: { value: 4200, currency: "dkk" }, leadDays: -4 }, { startAt: new Date(day(3)), kind: "renewal" });
    expect(p).toMatchObject({ direction: "owe", status: "open", kind: "renewal", dueAt: day(3), amount: { value: 4200, currency: "DKK" }, leadDays: null });
    expect(readProps({ amount: { value: "lots" } }).amount).toBeNull();
  });
});

describe("grouping", () => {
  const anna = { id: "p-anna", label: "Anna", type: "person" };
  const lars = { id: "p-lars", label: "Lars", type: "person" };
  const list = [
    view({ dueAt: day(-2) }, { responsible: [anna] }),
    view({ dueAt: day(1), kind: "payment" }, { responsible: [anna, lars] }),
    view({ dueAt: day(4), kind: "appointment", direction: "promise" }, { responsible: [lars] }),
    view({ dueAt: day(40), direction: "owed" }),
    view({ dueAt: null, direction: "owed" }),
    view({ status: "done", doneAt: day(-1) }, { responsible: [anna] }),
  ];
  it("by urgency, soonest first", () => {
    const g = groupByUrgency(list, NOW, TZ);
    expect([g.overdue.length, g.at_risk.length, g.this_week.length, g.later.length, g.undated.length]).toEqual([1, 1, 1, 1, 1]);
  });
  it("counts for the header: this week includes the at-risk ones due this week", () => {
    expect(countLedger(list, NOW, TZ)).toEqual({ open: 5, overdue: 1, atRisk: 1, thisWeek: 2, later: 1, undated: 1, done: 1 });
  });
  it("by person, with shared ones under each and nobody last", () => {
    const g = groupByPerson(list.filter((c) => c.props.status === "open"));
    expect(g.map((x) => [x.person?.label ?? null, x.items.length])).toEqual([["Anna", 2], ["Lars", 2], [null, 2]]);
  });
  it("by direction and tab", () => {
    const d = groupByDirection(list);
    expect([d.owe.length, d.owed.length, d.promise.length]).toEqual([3, 2, 1]);
    expect(filterTab(list, "owe").length).toBe(2);
    expect(filterTab(list, "owed").length).toBe(2);
    expect(filterTab(list, "done").length).toBe(1);
    expect(filterTab(list, "all").length).toBe(5);
    expect(filterPerson(list, "p-lars").length).toBe(2);
  });
});

describe("recurring", () => {
  it("steps by the rule, keeping the day of the month where it can", () => {
    expect(nextOccurrence("FREQ=YEARLY", "2026-12-01T09:00:00.000Z")).toBe("2027-12-01T09:00:00.000Z");
    expect(nextOccurrence("FREQ=MONTHLY", "2026-01-31T09:00:00.000Z")).toBe("2026-02-28T09:00:00.000Z");
    expect(nextOccurrence("RRULE:FREQ=WEEKLY;INTERVAL=2", "2026-11-05T09:00:00.000Z")).toBe("2026-11-19T09:00:00.000Z");
    expect(nextOccurrence("FREQ=MONTHLY;UNTIL=20261201", "2026-11-15T09:00:00.000Z")).toBeNull();
    expect(nextOccurrence("FREQ=HOURLY", "2026-11-05T09:00:00.000Z")).toBeNull();
    expect(nextOccurrence(null, "2026-11-05T09:00:00.000Z")).toBeNull();
  });
  it("moves the fingerprint's day along", () => {
    expect(moveFingerprint("renewal|tryg|car|2026-12-01", "2027-12-01T09:00:00.000Z")).toBe("renewal|tryg|car|2027-12-01");
    expect(moveFingerprint("something else", "2027-12-01T09:00:00.000Z")).toBe("something else");
  });
  it("proposes the next time with the same people and origin, open and not done", () => {
    let i = 0;
    const c = view({ kind: "renewal", recurrence: "FREQ=YEARLY", dueAt: "2026-12-01T09:00:00.000Z", status: "done", doneAt: day(0), doneBy: "u1" }, {
      id: "c-ins", label: "Renew the car insurance", responsible: [{ id: "p-anna", label: "Anna", type: "person", edgeId: "e1" }],
      counterparty: [{ id: "o-tryg", label: "Tryg", type: "organization" }], arisesFrom: [{ id: "d-pol", label: "Policy", type: "document" }],
    });
    const ops = rollForwardOps(c, () => `new-${++i}`)!;
    expect(ops[0]).toMatchObject({ op: "addNode", nodeId: "new-1", type: "commitment", startAt: "2027-12-01T09:00:00.000Z" });
    const p = (ops[0] as unknown as { props: CommitmentProps }).props;
    expect(p).toMatchObject({ status: "open", dueAt: "2027-12-01T09:00:00.000Z", previousId: "c-ins", recurrence: "FREQ=YEARLY" });
    expect(p.doneAt).toBeUndefined();
    expect(ops.slice(1).map((o) => o.op === "addEdge" && [o.fromId, o.relation, o.toId])).toEqual([
      ["p-anna", "responsible_for", "new-1"], ["new-1", "with", "o-tryg"], ["new-1", "arises_from", "d-pol"],
    ]);
    expect(rollForwardOps(view({ recurrence: null }))).toBeNull();
  });
});

describe("reminders", () => {
  it("fires lead days before, never in the past, never after it is due; follows a snooze", () => {
    expect(reminderDueAt(props({ kind: "payment", dueAt: day(10, 9) }), NOW)).toBe(day(7, 9));
    expect(reminderDueAt(props({ kind: "notice", dueAt: day(3) }), NOW)).toBe(NOW.toISOString());
    expect(reminderDueAt(props({ dueAt: day(-2) }), NOW)).toBe(day(-2));
    expect(reminderDueAt(props({ snoozedUntil: day(5) }), NOW)).toBe(day(5));
    expect(reminderDueAt(props({ dueAt: null }), NOW)).toBeNull();
    expect(reminderDueAt(props({ status: "done" }), NOW)).toBeNull();
  });
  const c = { id: "c1", label: "Pay the dentist bill", props: props({ kind: "payment", dueAt: day(10, 9) }), sourceIds: ["s1"] };
  it("finds the one linked to it first", () => {
    const r = matchReminder(c, [
      { id: "r0", nodeId: null, sourceId: "s1", title: "Pay the dentist bill", dueAt: day(10, 9), done: false },
      { id: "r1", nodeId: "c1", sourceId: null, title: "x", dueAt: day(7), done: false },
    ], NOW, TZ);
    expect(r?.id).toBe("r1");
  });
  it("adopts detection's reminder from the same source for the same day, or with the same words", () => {
    const sameDay = { id: "r2", nodeId: null, sourceId: "s1", title: "Tandlæge", dueAt: day(10, 7), done: false };
    const sameWords = { id: "r3", nodeId: null, sourceId: "s1", title: "Pay dentist bill", dueAt: day(1), done: false };
    const otherSource = { id: "r4", nodeId: null, sourceId: "s9", title: "Pay the dentist bill", dueAt: day(10, 9), done: false };
    expect(matchReminder(c, [otherSource, sameDay], NOW, TZ)?.id).toBe("r2");
    expect(matchReminder(c, [sameWords], NOW, TZ)?.id).toBe("r3");
    expect(matchReminder(c, [otherSource], NOW, TZ)).toBeNull();
    expect(planReminder(c, [sameDay], NOW, TZ)).toEqual({ action: "adopt", id: "r2", dueAt: day(7, 9) });
  });
  it("creates one when none exists, moves it when the date changes, closes it when done", () => {
    expect(planReminder(c, [], NOW, TZ)).toEqual({ action: "create", dueAt: day(7, 9) });
    const linked = { id: "r1", nodeId: "c1", sourceId: null, title: "x", dueAt: day(2), done: false };
    expect(planReminder(c, [linked], NOW, TZ)).toEqual({ action: "move", id: "r1", dueAt: day(7, 9) });
    expect(planReminder(c, [{ ...linked, dueAt: day(7, 15) }], NOW, TZ)).toEqual({ action: "none" });
    // Moved by hand to a later day before it is due: left alone.
    expect(planReminder(c, [{ ...linked, dueAt: day(9) }], NOW, TZ)).toEqual({ action: "none" });
    expect(planReminder({ ...c, props: { ...c.props, status: "done" } }, [linked], NOW, TZ)).toEqual({ action: "close", id: "r1" });
    expect(planReminder(c, [{ ...linked, done: true }], NOW, TZ)).toEqual({ action: "reopen", id: "r1", dueAt: day(7, 9) });
  });
});

describe("what the viewer may see", () => {
  it("drops parties and sources they can't read, and commitments outside their readable set", () => {
    const c = view({ doneEvidenceSourceId: "s-private" }, {
      responsible: [{ id: "p1", label: "Anna", type: "person" }, { id: "p-hidden", label: "Secret", type: "person" }],
      counterparty: [{ id: "o-hidden", label: "Private clinic", type: "organization" }],
      sources: [{ sourceId: "s1", title: "Letter", quote: null, chunkId: null, page: null, href: "/library/s1" }, { sourceId: "s-private", title: "Diary", quote: "…", chunkId: null, page: null, href: "/library/s-private" }],
    });
    const f = forViewer(c, new Set(["p1"]), new Set(["s1"]));
    expect(f.responsible.map((p) => p.id)).toEqual(["p1"]);
    expect(f.counterparty).toEqual([]);
    expect(f.sources.map((s) => s.sourceId)).toEqual(["s1"]);
    expect(f.props.doneEvidenceSourceId).toBeNull();
    expect(onlyReadable([c, view()], new Set([c.id])).map((x) => x.id)).toEqual([c.id]);
  });
});

describe("new commitment ops", () => {
  it("one node and its edges in the contract's directions, every op with the receipt", () => {
    let i = 0;
    const receipt = { sourceId: "s1", quote: "Svar senest 14. november" };
    const { nodeId, ops } = commitmentOps({
      label: "Reply to Vejle Kommune about school transport", direction: "owe", kind: "reply", dueAt: day(9),
      responsibleIds: ["p-anna"], aboutIds: ["p-emma"], arisesFromIds: ["d-letter"], newCounterparty: { label: "Vejle Kommune", type: "organization" }, receipt,
    }, () => `n${++i}`);
    expect(nodeId).toBe("n1");
    expect(ops.map((o) => o.op)).toEqual(["addNode", "addEdge", "addNode", "addEdge", "addEdge", "addEdge"]);
    expect(ops[0]).toMatchObject({ type: "commitment", kind: "reply", startAt: day(9), visibility: "household", props: { status: "open", leadDays: 5, dueKind: "deadline" } });
    expect(ops.filter((o) => o.op === "addEdge").map((o) => o.op === "addEdge" && [o.fromId, o.relation, o.toId])).toEqual([
      ["p-anna", "responsible_for", "n1"], ["n1", "with", "n2"], ["n1", "about", "p-emma"], ["n1", "arises_from", "d-letter"],
    ]);
    expect(ops.every((o) => o.receipt === receipt)).toBe(true);
  });
});

import { matchExisting } from "@/lib/changes/rebase";

describe("a proposed commitment against the graph", () => {
  const idx = [{ id: "n1", type: "commitment", kind: "payment", label: "Pay Noah's SFO fee", aliases: [], startAt: "2026-11-01T11:00:00.000Z" }];
  it("is the same one only on the same day", () => {
    expect(matchExisting({ type: "commitment", label: "Pay Noah's SFO fee", startAt: "2026-11-01T11:00:00.000Z" }, idx).kind).toBe("exists");
    expect(matchExisting({ type: "commitment", label: "Pay Noah's SFO fee", startAt: "2026-12-01T11:00:00.000Z" }, idx).kind).toBe("none");
  });
  it("leaves other types matched by name", () => {
    expect(matchExisting({ type: "person", label: "Anna" }, [{ id: "p", type: "person", kind: null, label: "Anna", aliases: [] }]).kind).toBe("exists");
  });
});
