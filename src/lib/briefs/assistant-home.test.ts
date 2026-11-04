import { describe, expect, it } from "vitest";
import {
  activityHref, alwaysAllowLabel, assistantBriefNotes, buildOnboardingExamples, buildSuggestedQuestions, canUseAssistantTools,
  canWriteInGraph, dayPhrase, defaultHeartbeat, specificTip, suggestionOriginLabel, suggestionPreview, workedFor, type QuestionInput,
} from "./assistant-home";

const TZ = "Europe/Copenhagen";
const now = new Date("2026-11-04T09:00:00Z"); // Wed 10:00 local

function input(over: Partial<QuestionInput> = {}): QuestionInput {
  return { now, tz: TZ, graphKind: "family", children: [], events: [], reminders: [], sources: [], ...over };
}

describe("access", () => {
  it("hides the assistant's tools from children and guests", () => {
    expect(canUseAssistantTools({ role: "owner" })).toBe(true);
    expect(canUseAssistantTools({ role: "parent" })).toBe(true);
    expect(canUseAssistantTools({ role: "child" })).toBe(false);
    expect(canUseAssistantTools({ role: "guest" })).toBe(false);
  });
  it("lets graph viewers read but not write", () => {
    expect(canWriteInGraph({ graphRole: "viewer" })).toBe(false);
    expect(canWriteInGraph({ graphRole: "editor" })).toBe(true);
  });
});

describe("suggestionOriginLabel", () => {
  it("names the check-in by time of day", () => {
    expect(suggestionOriginLabel({ origin: "heartbeat", createdAt: new Date("2026-11-04T06:30:00Z") }, now, TZ)).toBe("From this morning's check-in");
    expect(suggestionOriginLabel({ origin: "heartbeat", createdAt: new Date("2026-11-04T13:00:00Z") }, new Date("2026-11-04T15:00:00Z"), TZ)).toBe("From this afternoon's check-in");
    expect(suggestionOriginLabel({ origin: "heartbeat", createdAt: new Date("2026-11-03T18:00:00Z") }, now, TZ)).toBe("From yesterday's check-in");
    expect(suggestionOriginLabel({ origin: "heartbeat", createdAt: new Date("2026-11-02T08:00:00Z") }, now, TZ)).toBe("From Monday's check-in");
    expect(suggestionOriginLabel({ origin: "heartbeat", createdAt: new Date("2026-10-20T08:00:00Z") }, now, TZ)).toBe("From the check-in on 20 Oct");
  });
  it("names other origins plainly", () => {
    expect(suggestionOriginLabel({ origin: "chat", createdAt: now }, now, TZ)).toBe("From a chat with the assistant");
    expect(suggestionOriginLabel({ origin: "ingest", createdAt: now }, now, TZ)).toBe("From a file you added");
    expect(suggestionOriginLabel({ origin: "automation", createdAt: new Date("2026-11-04T07:00:00Z") }, now, TZ)).toBe("From this morning's automation run");
  });
});

describe("alwaysAllowLabel", () => {
  it("never offers Always allow for facts or merges", () => {
    expect(alwaysAllowLabel("fact")).toBeUndefined();
    expect(alwaysAllowLabel("merge")).toBeUndefined();
    expect(alwaysAllowLabel("reminder")).toBe("Always allow new reminders");
  });
});

describe("suggestionPreview", () => {
  it("uses the body when there is one", () => {
    expect(suggestionPreview({ body: " Pack a lunch ", payload: { title: "x" } }, TZ)).toEqual([{ label: null, value: "Pack a lunch" }]);
  });
  it("lists known payload fields and formats dates in the household zone", () => {
    const lines = suggestionPreview({ body: null, payload: { title: "Sign the zoo slip", dueAt: "2026-11-05T17:00:00Z", secret: { a: 1 }, about: "Emma" } }, TZ);
    expect(lines).toEqual([
      { label: "Title", value: "Sign the zoo slip" },
      { label: "Due", value: "Thu 5 Nov, 18:00" },
      { label: "About", value: "Emma" },
    ]);
  });
  it("skips objects and caps the number of lines", () => {
    const payload = Object.fromEntries(["title", "text", "label", "relation", "dueAt", "startAt", "about", "detail"].map((k) => [k, k === "dueAt" || k === "startAt" ? "2026-11-05T10:00:00Z" : "v"]));
    expect(suggestionPreview({ body: null, payload }, TZ)).toHaveLength(6);
    expect(suggestionPreview({ body: null, payload: { meta: { x: 1 } } }, TZ)).toEqual([]);
  });
});

describe("activityHref", () => {
  const base = { actor: "chat", subjectType: null, subjectId: null, runId: null, conversationId: null };
  it("prefers the conversation, then the run, then the subject", () => {
    expect(activityHref({ ...base, conversationId: "c1", runId: "r1" })).toBe("/chat/c1");
    expect(activityHref({ ...base, runId: "r1", subjectType: "node", subjectId: "n1" })).toBe("/automations?run=r1");
    expect(activityHref({ ...base, subjectType: "node", subjectId: "n1" })).toBe("/node/n1");
    expect(activityHref({ ...base, subjectType: "source", subjectId: "s1" })).toBe("/library/s1");
    expect(activityHref({ ...base, subjectType: "mystery", subjectId: "x" })).toBeNull();
    expect(activityHref(base)).toBeNull();
  });
});

describe("dayPhrase", () => {
  it("says today, tomorrow, a weekday this week, else a date", () => {
    expect(dayPhrase(new Date("2026-11-04T15:00:00Z"), now, TZ)).toBe("today");
    expect(dayPhrase(new Date("2026-11-05T07:00:00Z"), now, TZ)).toBe("tomorrow");
    expect(dayPhrase(new Date("2026-11-07T07:00:00Z"), now, TZ)).toBe("on Saturday");
    expect(dayPhrase(new Date("2026-11-24T07:30:00Z"), now, TZ)).toBe("on Tue 24 Nov");
  });
});

describe("buildSuggestedQuestions", () => {
  const family = input({
    children: [{ name: "Emma" }, { name: "Noah" }],
    events: [
      { label: "Field trip to the Zoo", startAt: new Date("2026-11-05T07:30:00Z"), people: ["Emma"] },
      { label: "Dentist appointment Noah", startAt: new Date("2026-11-09T14:15:00Z"), people: ["Noah"] },
    ],
    reminders: [{ title: "Permission slip deadline", dueAt: new Date("2026-11-06T22:00:00Z"), about: "Emma" }],
    sources: [{ title: "school-letter-2.txt", createdAt: new Date("2026-11-03T10:00:00Z") }],
  });

  it("writes questions from the family's own data", () => {
    const qs = buildSuggestedQuestions(family).map((q) => q.q);
    expect(qs[0]).toBe("What do we need for Emma's field trip to the Zoo tomorrow?");
    expect(qs).toContain("Summarise this week's school letter");
    expect(qs).toContain("What do we still need to sign, pay or book in the next two weeks?");
    expect(qs).toHaveLength(4);
  });

  it("removes the child's name from the label when it is about them", () => {
    const qs = buildSuggestedQuestions(family, 10).map((q) => q.q);
    expect(qs).toContain("What should we remember for Noah's dentist appointment on Monday?");
  });

  it("never repeats a question and respects the cap", () => {
    const qs = buildSuggestedQuestions(input({ children: [{ name: "Emma" }, { name: "Emma" }] }), 10).map((q) => q.q);
    expect(new Set(qs).size).toBe(qs.length);
    expect(buildSuggestedQuestions(family, 2)).toHaveLength(2);
  });

  it("falls back to general questions in an empty graph", () => {
    expect(buildSuggestedQuestions(input({ graphKind: "shared" })).map((q) => q.q)).toEqual(["What's in this graph so far?"]);
    expect(buildSuggestedQuestions(input()).map((q) => q.q)).toEqual(["What do I need for tomorrow?", "What's in this graph so far?"]);
  });

  it("ignores past events and old files", () => {
    const qs = buildSuggestedQuestions(input({
      events: [{ label: "Zoo trip", startAt: new Date("2026-10-01T08:00:00Z"), people: [] }],
      sources: [{ title: "Aula letter", createdAt: new Date("2026-10-01T08:00:00Z") }],
    })).map((q) => q.q);
    expect(qs.some((q) => /zoo|letter/i.test(q))).toBe(false);
  });

  it("gives three onboarding examples", () => {
    expect(buildOnboardingExamples(family)).toHaveLength(3);
  });
});

describe("specificTip", () => {
  it("uses a real person and event when there is one", () => {
    const tip = specificTip(input({ children: [{ name: "Emma" }], events: [{ label: "Field trip to the Zoo", startAt: new Date("2026-11-05T07:30:00Z"), people: ["Emma"] }] }));
    expect(tip.after).toBe("What does Emma need for the field trip to the Zoo tomorrow, and is anything still to sign?");
  });
  it("has a sensible fallback", () => {
    expect(specificTip(input()).after).toMatch(/deadline/);
  });
});

describe("assistantBriefNotes", () => {
  it("is empty when nothing waits", () => {
    expect(assistantBriefNotes({ now, tz: TZ, pending: [], heartbeat: null })).toBe("");
  });
  it("lists pending suggestions and today's check-in", () => {
    const text = assistantBriefNotes({
      now, tz: TZ,
      pending: [{ title: "Add reminder: sign slip" }, { title: "b" }, { title: "c" }, { title: "d" }],
      heartbeat: { summary: "Found a new Aula letter.", createdAt: new Date("2026-11-04T07:00:00Z") },
    });
    expect(text).toContain("4 suggestions");
    expect(text).toContain(", …");
    expect(text).toContain("Latest check-in (today at 08:00): Found a new Aula letter.");
  });
  it("drops stale check-ins", () => {
    expect(assistantBriefNotes({ now, tz: TZ, pending: [], heartbeat: { summary: "x", createdAt: new Date("2026-10-01T07:00:00Z") } })).toBe("");
  });
});

describe("workedFor", () => {
  it("formats durations", () => {
    expect(workedFor(undefined)).toBeNull();
    expect(workedFor(300)).toBe("worked for 1s");
    expect(workedFor(4200)).toBe("worked for 4s");
    expect(workedFor(65_000)).toBe("worked for 1 min 5s");
    expect(workedFor(120_000)).toBe("worked for 2 min");
  });
});

describe("defaultHeartbeat", () => {
  it("checks every hour, every day, 07:00 to 20:00, and only proposes", () => {
    const hb = defaultHeartbeat(TZ);
    expect(hb.trigger).toBe("heartbeat");
    expect(hb.config).toEqual({ everyMinutes: 60, days: [0, 1, 2, 3, 4, 5, 6], from: "07:00", to: "20:00", tz: TZ });
    expect(hb.prompt).toMatch(/only propose/i);
  });
});

describe("outings from reminders", () => {
  it("asks about an outing that is only on the to-do list", () => {
    const qs = buildSuggestedQuestions(input({
      children: [{ name: "Emma" }],
      reminders: [{ title: "Field trip to the Zoo", dueAt: new Date("2026-11-24T07:30:00Z"), about: "Emma" }],
    })).map((q) => q.q);
    expect(qs[0]).toBe("What do we need for Emma's field trip to the Zoo on Tue 24 Nov?");
  });
});

describe("labels that start with a name", () => {
  it("drops a leading 'Emma:' and keeps the rest readable", () => {
    const qs = buildSuggestedQuestions(input({
      children: [{ name: "Emma" }],
      reminders: [{ title: "Emma: Field trip to the Zoo", dueAt: new Date("2026-11-24T07:30:00Z"), about: "Emma" }],
    })).map((q) => q.q);
    expect(qs[0]).toBe("What do we need for Emma's field trip to the Zoo on Tue 24 Nov?");
  });
  it("prefers an outing for the be-specific tip", () => {
    const tip = specificTip(input({
      children: [{ name: "Emma" }],
      events: [{ label: "School start", startAt: new Date("2026-11-04T15:00:00Z"), people: ["Emma"] }],
      reminders: [{ title: "Field trip to the Zoo", dueAt: new Date("2026-11-24T07:30:00Z"), about: "Emma" }],
    }));
    expect(tip.after).toContain("field trip to the Zoo");
  });
});

describe("onboarding examples in an empty graph", () => {
  it("always offers three", () => {
    expect(buildOnboardingExamples(input({ graphKind: "shared" }))).toEqual(["What's in this graph so far?", "Who is in this graph so far?", "What can you help me with here?"]);
  });
});
