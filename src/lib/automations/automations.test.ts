import { describe, expect, it } from "vitest";
import {
  afterRun, describeTrigger, inHeartbeatWindow, isDue, leaseUntil, CLAIM_LEASE_MS, localParts, nextHeartbeatRun, nextRun,
  nextScheduleRun, parseTrigger, previewRuns, safeParseTrigger, zonedTime,
} from "./schedule";
import {
  alwaysLabelFor, applyUnattendedPolicy, autoApplies, canCreateAssistantWork, canUseAssistantTools, conditionKeywords, dedupeGroup,
  dedupeVerdict, firstFreeSlot, isBusy, isStale, overDailyCap, prefilter, safeInternalHref, startOfLocalDay, validatePayload,
} from "./policy";
import { birthdayReminderAt, buildHeartbeatProposals, heartbeatSummary, setKey, type HeartbeatData } from "./heartbeat-pure";
import { canEditRecipe, canSeeRecipe, fillRecipe, recipePlaceholders, STARTER_RECIPES, starterRecipesFor } from "@/lib/recipes/pure";
import { paragraphsDoc } from "./apply-doc";

const CPH = "Europe/Copenhagen";
const iso = (d: Date | null) => d?.toISOString() ?? null;

describe("zoned time", () => {
  it("converts wall-clock times both sides of DST", () => {
    expect(iso(zonedTime(2026, 7, 1, 18, 0, CPH))).toBe("2026-07-01T16:00:00.000Z"); // CEST +2
    expect(iso(zonedTime(2026, 12, 1, 18, 0, CPH))).toBe("2026-12-01T17:00:00.000Z"); // CET +1
  });
  it("moves a time in the spring-forward gap past the gap", () => {
    // 29 March 2026: 02:00 → 03:00 in Copenhagen. 02:30 doesn't exist.
    const d = zonedTime(2026, 3, 29, 2, 30, CPH);
    const p = localParts(d, CPH);
    expect([p.hour, p.minute]).toEqual([3, 30]);
  });
  it("uses the first of two 02:30s on the autumn night", () => {
    // 25 October 2026: 03:00 → 02:00. 02:30 happens at 00:30Z (+2) and 01:30Z (+1).
    expect(iso(zonedTime(2026, 10, 25, 2, 30, CPH))).toBe("2026-10-25T00:30:00.000Z");
  });
});

describe("schedule", () => {
  const sundays18 = parseTrigger("schedule", { days: [0], time: "18:00", tz: CPH });
  it("finds the next Sunday 18:00", () => {
    // Wednesday 4 Nov 2026 → Sunday 8 Nov 18:00 CET = 17:00Z
    expect(iso(nextRun(sundays18, new Date("2026-11-04T10:00:00Z")))).toBe("2026-11-08T17:00:00.000Z");
  });
  it("is strictly after the given instant", () => {
    expect(iso(nextRun(sundays18, new Date("2026-11-08T17:00:00Z")))).toBe("2026-11-15T17:00:00.000Z");
  });
  it("keeps 18:00 local across the DST change", () => {
    const runs = previewRuns(sundays18, new Date("2026-10-20T00:00:00Z"), 3);
    expect(runs.map(iso)).toEqual(["2026-10-25T17:00:00.000Z", "2026-11-01T17:00:00.000Z", "2026-11-08T17:00:00.000Z"]);
    const before = previewRuns(sundays18, new Date("2026-10-12T00:00:00Z"), 1);
    expect(iso(before[0])).toBe("2026-10-18T16:00:00.000Z"); // still summer time
  });
  it("runs once on a date, and never after it", () => {
    const c = parseTrigger("schedule", { time: "09:00", date: "2026-12-24", tz: CPH });
    expect(iso(nextRun(c, new Date("2026-11-04T00:00:00Z")))).toBe("2026-12-24T08:00:00.000Z");
    expect(nextRun(c, new Date("2026-12-25T00:00:00Z"))).toBeNull();
    expect(previewRuns(c, new Date("2026-11-04T00:00:00Z"), 3)).toHaveLength(1);
  });
  it("rejects bad configs", () => {
    expect(safeParseTrigger("schedule", { days: [], time: "18:00" })).toBeNull();
    expect(safeParseTrigger("schedule", { days: [1], time: "25:00" })).toBeNull();
    expect(safeParseTrigger("schedule", { days: [1], time: "08:00", tz: "Mars/Olympus" })).toBeNull();
  });
  it("describes triggers in plain words", () => {
    expect(describeTrigger(sundays18)).toBe("Sundays at 18:00");
    expect(describeTrigger(parseTrigger("schedule", { days: [1, 2, 3, 4, 5], time: "07:30" }))).toBe("Weekdays at 07:30");
    expect(describeTrigger(parseTrigger("heartbeat", { everyMinutes: 60, days: [1, 2, 3, 4, 5], from: "07:00", to: "20:00" })))
      .toBe("Every hour, weekdays 07:00–20:00");
    expect(describeTrigger(parseTrigger("condition", { check: "A document mentions a vaccination", everyMinutes: 30 })))
      .toBe("Every 30 minutes, when a document mentions a vaccination");
  });
});

describe("heartbeat window", () => {
  const hb = parseTrigger("heartbeat", { everyMinutes: 60, days: [1, 2, 3, 4, 5], from: "07:00", to: "20:00", tz: CPH });
  if (hb.trigger !== "heartbeat") throw new Error();
  it("knows when it is inside its days and hours", () => {
    expect(inHeartbeatWindow(hb.config, new Date("2026-11-04T09:00:00Z"))).toBe(true); // Wed 10:00
    expect(inHeartbeatWindow(hb.config, new Date("2026-11-04T19:30:00Z"))).toBe(false); // Wed 20:30
    expect(inHeartbeatWindow(hb.config, new Date("2026-11-07T10:00:00Z"))).toBe(false); // Saturday
  });
  it("steps every N minutes inside the window", () => {
    expect(iso(nextHeartbeatRun(hb.config, new Date("2026-11-04T09:00:30Z")))).toBe("2026-11-04T10:00:00.000Z");
  });
  it("jumps to the next opening outside the window", () => {
    // Wed 19:30 local + 60 min = 20:30 → Thursday 07:00 local = 06:00Z
    expect(iso(nextHeartbeatRun(hb.config, new Date("2026-11-04T18:30:00Z")))).toBe("2026-11-05T06:00:00.000Z");
    // Friday evening → Monday 07:00
    expect(iso(nextHeartbeatRun(hb.config, new Date("2026-11-06T19:30:00Z")))).toBe("2026-11-09T06:00:00.000Z");
  });
  it("opens at 07:00 local on both sides of DST", () => {
    expect(iso(nextHeartbeatRun(hb.config, new Date("2026-10-23T20:00:00Z")))).toBe("2026-10-26T06:00:00.000Z"); // Mon after DST end
    expect(iso(nextHeartbeatRun(hb.config, new Date("2026-10-15T20:00:00Z")))).toBe("2026-10-16T05:00:00.000Z"); // summer
  });
  it("only allows the offered intervals and a sensible window", () => {
    expect(safeParseTrigger("heartbeat", { everyMinutes: 5 })).toBeNull();
    expect(safeParseTrigger("heartbeat", { everyMinutes: 30, from: "20:00", to: "07:00" })).toBeNull();
  });
});

describe("claiming", () => {
  const now = new Date("2026-11-04T10:00:00Z");
  it("is due only when enabled and the time has come", () => {
    expect(isDue({ enabled: true, nextRunAt: new Date("2026-11-04T09:59:00Z") }, now)).toBe(true);
    expect(isDue({ enabled: true, nextRunAt: new Date("2026-11-04T10:01:00Z") }, now)).toBe(false);
    expect(isDue({ enabled: false, nextRunAt: new Date("2026-11-04T09:00:00Z") }, now)).toBe(false);
    expect(isDue({ enabled: true, nextRunAt: null }, now)).toBe(false);
  });
  it("leases a claimed run so a crash is retried later, not at once", () => {
    expect(leaseUntil(now).getTime() - now.getTime()).toBe(CLAIM_LEASE_MS);
  });
  it("switches one-shots off after a successful run, and keeps them on after a failure", () => {
    const t = parseTrigger("schedule", { days: [0], time: "18:00", tz: CPH });
    expect(afterRun({ oneShot: true }, t, "done", now)).toEqual({ enabled: false, nextRunAt: null });
    const failed = afterRun({ oneShot: true }, t, "failed", now);
    expect(failed.enabled).toBe(true);
    expect(iso(failed.nextRunAt)).toBe("2026-11-08T17:00:00.000Z");
    expect(afterRun({ oneShot: false }, t, "done", now).enabled).toBe(true);
    expect(afterRun({ oneShot: false }, null, "done", now)).toEqual({ enabled: false, nextRunAt: null });
  });
});

describe("cap and dedupe", () => {
  it("never repeats something that was denied, and reuses a pending one", () => {
    expect(dedupeVerdict([])).toBe("new");
    expect(dedupeVerdict([{ status: "expired" }])).toBe("new");
    expect(dedupeVerdict([{ status: "pending" }])).toBe("existing");
    expect(dedupeVerdict([{ status: "approved" }])).toBe("existing");
    expect(dedupeVerdict([{ status: "pending" }, { status: "denied" }])).toBe("never");
  });
  it("caps proactive suggestions per day but not chat answers", () => {
    expect(overDailyCap("heartbeat", 4, 5)).toBe(false);
    expect(overDailyCap("heartbeat", 5, 5)).toBe(true);
    expect(overDailyCap("automation", 0, 0)).toBe(true);
    expect(overDailyCap("chat", 99, 5)).toBe(false);
  });
  it("reads group keys", () => {
    expect(dedupeGroup("hb:due#abc")).toBe("hb:due");
    expect(dedupeGroup("hb:fact:123")).toBeNull();
    expect(dedupeGroup(null)).toBeNull();
  });
  it("expires suggestions after two weeks", () => {
    const now = new Date("2026-11-20T00:00:00Z");
    expect(isStale(new Date("2026-11-01T00:00:00Z"), now)).toBe(true);
    expect(isStale(new Date("2026-11-10T00:00:00Z"), now)).toBe(false);
  });
  it("starts the day at local midnight", () => {
    expect(iso(startOfLocalDay(new Date("2026-11-04T10:17:00Z"), CPH))).toBe("2026-11-03T23:00:00.000Z");
    expect(iso(startOfLocalDay(new Date("2026-07-04T10:17:00Z"), CPH))).toBe("2026-07-03T22:00:00.000Z");
  });
  it("set keys don't depend on order", () => {
    expect(setKey(["a", "b"])).toBe(setKey(["b", "a"]));
    expect(setKey(["a"])).not.toBe(setKey(["b"]));
  });
});

describe("unattended policy", () => {
  it("lets reads and proposals through and lists everything else as skipped", () => {
    const r = applyUnattendedPolicy([
      { type: "read", label: "Read Emma's school letters" },
      { type: "propose", label: "Suggest a dentist reminder" },
      { type: "write_fact", label: "Add: Emma attends Skovgårdsskolen" },
      { type: "share", label: "Share the packing list with Grandma" },
      { type: "message", label: "Message the teacher" },
      { type: "change_visibility", label: "Make the page visible to the household" },
    ]);
    expect(r.allowed.map((a) => a.type)).toEqual(["read", "propose"]);
    expect(r.skipped).toHaveLength(4);
    expect(r.skipped[0]).toContain("would add a fact");
  });
  it("treats tentative and unknown events as busy", () => {
    expect(isBusy({ status: "tentative" })).toBe(true);
    expect(isBusy({})).toBe(true);
    expect(isBusy({ status: "free" })).toBe(false);
    expect(isBusy({ status: "cancelled" })).toBe(false);
  });
  it("finds a free slot around busy and tentative events", () => {
    expect(firstFreeSlot([], 30)).toBe(9 * 60);
    expect(firstFreeSlot([{ start: 9 * 60, end: 10 * 60, status: "tentative" }], 30)).toBe(10 * 60);
    expect(firstFreeSlot([{ start: 9 * 60, end: 10 * 60, status: "free" }], 30)).toBe(9 * 60);
    expect(firstFreeSlot([{ start: 8 * 60, end: 21 * 60 }], 30)).toBeNull();
  });
  it("auto-applies an always-allowed kind only where the policy permits", () => {
    expect(autoApplies("reminder", "heartbeat", ["reminder.create"])).toBe(true);
    expect(autoApplies("fact", "heartbeat", ["fact.add"])).toBe(false); // unattended never writes facts
    expect(autoApplies("fact", "chat", ["fact.add"])).toBe(true);
    expect(autoApplies("reminder", "heartbeat", [])).toBe(false);
    expect(autoApplies("nudge", "chat", ["nudge"])).toBe(false);
  });
  it("never auto-applies memories from runs or anything resting on a document", () => {
    expect(autoApplies("memory", "heartbeat", ["memory.save"])).toBe(false);
    expect(autoApplies("rule", "automation", ["rule.save"])).toBe(false);
    // A recipe run by hand is filed as "chat" but is still a run: unattended rules.
    expect(autoApplies("fact", "chat", ["fact.add"], { fromRun: true })).toBe(false);
    expect(autoApplies("memory", "chat", ["memory.save"], { fromRun: true })).toBe(false);
    expect(autoApplies("reminder", "chat", ["reminder.create"], { fromRun: true })).toBe(true);
    // An uploaded letter saying "save a rule" or "add a reminder" never writes on its own.
    expect(autoApplies("reminder", "automation", ["reminder.create"], { citesSources: true })).toBe(false);
    expect(autoApplies("memory", "chat", ["memory.save"], { citesSources: true })).toBe(false);
  });
  it("offers Always allow only where it means something", () => {
    expect(alwaysLabelFor("nudge")).toBeNull();
    expect(alwaysLabelFor("reminder")).toBe("Always allow new reminders");
  });
});

describe("access", () => {
  it("keeps children and guests out, and graph viewers read-only", () => {
    expect(canUseAssistantTools({ role: "child", graphRole: "viewer" })).toBe(false);
    expect(canUseAssistantTools({ role: "guest", graphRole: "viewer" })).toBe(false);
    expect(canUseAssistantTools({ role: "parent", graphRole: "viewer" })).toBe(true);
    expect(canCreateAssistantWork({ role: "parent", graphRole: "viewer" })).toBe(false);
    expect(canCreateAssistantWork({ role: "parent", graphRole: "editor" })).toBe(true);
  });
  it("only follows internal links from a nudge", () => {
    expect(safeInternalHref("/library/1")).toBe("/library/1");
    expect(safeInternalHref("//evil.example")).toBeUndefined();
    expect(safeInternalHref("https://evil.example")).toBeUndefined();
  });
});

describe("payloads", () => {
  it("validates what approving would write", () => {
    expect(validatePayload("reminder", { title: "Dentist", dueAt: "2026-11-10T08:00:00Z" }).ok).toBe(true);
    expect(validatePayload("reminder", { title: "Dentist", dueAt: "soon" }).ok).toBe(false);
    expect(validatePayload("fact", { edgeId: "6f1c1a7e-2b7a-4a8e-9a55-3c7d4f6a1b20" }).ok).toBe(true);
    expect(validatePayload("fact", { relation: "attends", from: { label: "Emma" } }).ok).toBe(false);
    expect(validatePayload("merge", { keepId: "6f1c1a7e-2b7a-4a8e-9a55-3c7d4f6a1b20", dropId: "6f1c1a7e-2b7a-4a8e-9a55-3c7d4f6a1b20" }).ok).toBe(false);
    expect(validatePayload("nudge", {}).ok).toBe(true);
  });
  it("turns text into wiki paragraphs", () => {
    expect(paragraphsDoc("One\nline\n\nTwo")).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "One line" }] },
      { type: "paragraph", content: [{ type: "text", text: "Two" }] },
    ]);
  });
});

describe("condition prefilter", () => {
  it("pulls keywords and stems them", () => {
    const k = conditionKeywords("a document mentions a vaccination");
    expect(k).toEqual(["vaccin"]);
    const items = [{ text: "Invitation to MMR vaccine at school" }, { text: "Football practice moved" }, { text: "Emma was vaccinated today" }];
    expect(prefilter(items, k).map((i) => i.text)).toEqual(["Invitation to MMR vaccine at school", "Emma was vaccinated today"]);
  });
  it("lets everything through when the condition has no keywords", () => {
    expect(prefilter([{ text: "a" }], conditionKeywords("when something new arrives"))).toHaveLength(1);
  });
});

describe("heartbeat proposals", () => {
  const now = new Date("2026-11-04T09:00:00Z");
  const base: HeartbeatData = { uploads: [], dueSoon: [], overdue: [], birthdays: [], outOfTouch: [], facts: { edges: [], total: 0 }, reminderTitles: [] };
  const caps = { library: true, people: true, reminders: true, timeline: true, wiki_write: true };
  it("proposes nothing on a quiet day", () => {
    expect(buildHeartbeatProposals(base, { now, tz: CPH, capabilities: caps })).toEqual([]);
    expect(heartbeatSummary(0, 0, base)).toBe("Nothing needs you right now.");
  });
  it("groups due and overdue reminders into one nudge each, with stable keys", () => {
    const d = { ...base, overdue: [{ id: "r1", title: "Permission slip", dueAt: now, aboutLabel: "Emma" }], dueSoon: [
      { id: "r2", title: "Pay for the trip", dueAt: now, aboutLabel: null }, { id: "r3", title: "Bake for the party", dueAt: now, aboutLabel: "Oscar" }] };
    const p = buildHeartbeatProposals(d, { now, tz: CPH, capabilities: caps });
    expect(p.map((x) => x.kind)).toEqual(["nudge", "nudge"]);
    expect(p[0].title).toBe("Overdue: Permission slip");
    expect(p[1].title).toBe("2 things due in the next two days");
    expect(p[1].dedupeKey.startsWith("hb:due#")).toBe(true);
  });
  it("suggests a birthday reminder the day before, unless one exists", () => {
    const b = { personId: "p1", label: "Mormor", date: new Date("2026-11-09T00:00:00Z"), daysUntil: 5, turning: 70 };
    const p = buildHeartbeatProposals({ ...base, birthdays: [b] }, { now, tz: CPH, capabilities: caps });
    expect(p[0].kind).toBe("reminder");
    expect(p[0].payload.dueAt).toBe("2026-11-08T08:00:00.000Z"); // 09:00 local the day before
    const q = buildHeartbeatProposals({ ...base, birthdays: [b], reminderTitles: ["mormor's birthday (70): present or call"] }, { now, tz: CPH, capabilities: caps });
    expect(q[0].kind).toBe("nudge");
  });
  it("respects capabilities that are switched off", () => {
    const d = { ...base, uploads: [{ id: "s1", title: "Aula letter", createdAt: now }], outOfTouch: [{ personId: "p2", label: "Anders", daysSince: 40, cadenceDays: 30 }] };
    const p = buildHeartbeatProposals(d, { now, tz: CPH, capabilities: { ...caps, library: false, people: false } });
    expect(p).toEqual([]);
  });
  it("asks to confirm a couple of facts and summarises the rest", () => {
    const e = (id: string) => ({ id, fromId: "n1", fromLabel: "Emma", toLabel: "Skovgårdsskolen", relationLabel: "attends", confidence: 0.7, sourceId: "s1", sourceTitle: "Aula letter" });
    const p = buildHeartbeatProposals({ ...base, facts: { edges: [e("e1"), e("e2")], total: 14 } }, { now, tz: CPH, capabilities: caps });
    expect(p.filter((x) => x.kind === "fact")).toHaveLength(2);
    expect(p.at(-1)!.title).toBe("12 more facts waiting to be checked");
    expect(p[0].payload).toEqual({ edgeId: "e1" });
  });
  it("picks the first free time for a birthday reminder", () => {
    expect(birthdayReminderAt(new Date("2026-11-09T00:00:00Z"), CPH, 10 * 60 + 30)).toBe("2026-11-08T09:30:00.000Z");
  });
});

describe("recipes", () => {
  it("finds and fills placeholders", () => {
    expect(recipePlaceholders("Pack for <trip> with <child> and <trip>")).toEqual(["trip", "child"]);
    expect(fillRecipe("Pack for <trip>", { trip: "Skagen" })).toBe("Pack for Skagen");
    expect(fillRecipe("Pack for <trip>", {})).toBe("Pack for (not given)");
  });
  it("ships four family starters", () => {
    expect(STARTER_RECIPES.map((r) => r.name)).toEqual([
      "Weekly family summary", "What do we need to pack for <trip>", "Prepare for the next parent-teacher meeting", "Who haven't we seen in a while",
    ]);
  });
  it("seeds starters that follow the graph's template", () => {
    expect(starterRecipesFor("family")).toBe(STARTER_RECIPES);
    for (const kind of ["work", "project", "partner", "personal", "shared", "other"]) {
      const text = starterRecipesFor(kind).map((r) => `${r.name} ${r.description} ${r.prompt}`).join(" ").toLowerCase();
      expect(text).not.toMatch(/family|parent-teacher|school|kids|pack for/);
    }
    expect(starterRecipesFor("work").map((r) => r.name)).toContain("Weekly status");
  });
  it("follows visibility and graph", () => {
    const parent = { id: "u1", householdId: "h", role: "parent" as const };
    const other = { id: "u2", householdId: "h", role: "parent" as const };
    expect(canSeeRecipe(parent, { ownerId: "u2", visibility: "household" })).toBe(true);
    expect(canSeeRecipe(parent, { ownerId: "u2", visibility: "private" })).toBe(false);
    expect(canSeeRecipe(parent, { ownerId: "u2", visibility: "parents" })).toBe(true);
    expect(canSeeRecipe({ id: "c", householdId: "h", role: "guest" as const }, { ownerId: "u2", visibility: "household" })).toBe(false);
    expect(canEditRecipe(other, { ownerId: "u1" })).toBe(false);
    expect(canEditRecipe(parent, { ownerId: "u1" })).toBe(true);
    const inG = { ...parent, graphId: "g1", graphName: "F", graphKind: "family" as const, graphRole: "editor" as const, graphHouseholdId: "h", graphOwnerId: null };
    expect(canSeeRecipe(inG, { ownerId: "u1", visibility: "household", graphId: "g2" })).toBe(false);
  });
});
