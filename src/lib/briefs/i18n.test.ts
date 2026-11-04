import { describe, expect, it } from "vitest";
import { lookup } from "@/lib/i18n/core";
import enToday from "@/lib/i18n/messages/en/today";
import daToday from "@/lib/i18n/messages/da/today";
import enOnboarding from "@/lib/i18n/messages/en/onboarding";
import daOnboarding from "@/lib/i18n/messages/da/onboarding";
import { getTemplate, GRAPH_TEMPLATE_KINDS } from "@/lib/templates/templates";
import {
  alwaysAllowLabel, buildOnboardingExamples, buildSuggestedQuestions, dayPhrase, possessive, specificTip,
  suggestionKindLabel, suggestionOriginLabel, workedFor, type QuestionInput,
} from "./assistant-home";
import { ageLabel, formatLongDate, formatShortDay, formatWhen, greetingFor, groupByBucket } from "./dates";
import { buildBriefMessages } from "./context";
import { dueLabel, weekDays } from "@/components/today/week";

const TZ = "Europe/Copenhagen";
const now = new Date("2026-11-04T09:00:00Z"); // Wednesday 10:00 local
const input = (over: Partial<QuestionInput> = {}): QuestionInput => ({ now, tz: TZ, graphKind: "family", children: [], events: [], reminders: [], sources: [], ...over });

/** Every leaf key in a message tree, dotted. */
function leaves(tree: object, prefix = ""): string[] {
  return Object.entries(tree).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") return [key];
    if (v && typeof v === "object" && "one" in v && "other" in v) return [key];
    return leaves(v as object, key);
  });
}

describe("messages", () => {
  it("has Danish for every English key on Today and in onboarding", () => {
    for (const [en, da, ns] of [[enToday, daToday, "today"], [enOnboarding, daOnboarding, "onboarding"]] as const) {
      const missing = leaves(en).filter((k) => lookup({ [ns]: da }, `${ns}.${k}`) === undefined);
      expect(missing).toEqual([]);
    }
  });
  it("has a Danish version of every template example prompt", () => {
    for (const kind of GRAPH_TEMPLATE_KINDS) {
      getTemplate(kind).prompts.forEach((_, i) => expect(lookup({ today: daToday }, `today.templatePrompts.${kind}.${i}`), `${kind} ${i}`).toBeTypeOf("string"));
    }
  });
});

describe("dates in Danish", () => {
  it("spells days and months the Danish way", () => {
    expect(formatShortDay(new Date("2026-11-06T09:00:00Z"), TZ, "da")).toBe("fre 6. nov");
    expect(formatWhen(new Date("2026-11-04T13:30:00Z"), now, TZ, true, "da")).toBe("I dag kl. 14.30");
    expect(formatWhen(new Date("2026-11-05T07:00:00Z"), now, TZ, false, "da")).toBe("I morgen");
    expect(formatLongDate(now, TZ, "da")).toMatch(/^Onsdag den 4\. november 2026$/);
    expect(greetingFor(now, TZ, "da")).toBe("Godmorgen");
    expect(ageLabel(10, "da")).toBe("Fylder 10 i år");
    expect(weekDays(now, TZ, 0, "da").map((d) => d.weekday).slice(0, 3)).toEqual(["ons", "tor", "fre"]);
    expect(dueLabel(new Date("2026-11-04T22:59:00Z"), now, TZ, "da")).toBe("inden dagen er omme");
  });
  it("labels reminder buckets in Danish", () => {
    const groups = groupByBucket([{ at: new Date("2026-11-03T08:00:00Z") }, { at: now }], (x) => x.at, now, TZ, "da");
    expect(groups.map((g) => g.label)).toEqual(["Overskredet", "I dag"]);
  });
  it("keeps English unchanged by default", () => {
    expect(formatWhen(new Date("2026-11-04T13:30:00Z"), now, TZ)).toBe("Today 14:30");
    expect(formatLongDate(now, TZ)).toBe("Wednesday, 4 November 2026");
  });
});

describe("assistant labels in Danish", () => {
  it("says where a suggestion came from", () => {
    expect(suggestionOriginLabel({ origin: "heartbeat", createdAt: new Date("2026-11-04T06:30:00Z") }, now, TZ, "da")).toBe("Fra tjekket i morges");
    expect(suggestionOriginLabel({ origin: "heartbeat", createdAt: new Date("2026-11-02T08:00:00Z") }, now, TZ, "da")).toBe("Fra tjekket i mandags");
    expect(suggestionOriginLabel({ origin: "heartbeat", createdAt: new Date("2026-10-20T08:00:00Z") }, now, TZ, "da")).toBe("Fra tjekket den 20. okt");
  });
  it("only says 'family rule' in a family graph", () => {
    expect(suggestionKindLabel("rule", "en", "family")).toBe("Family rule");
    expect(suggestionKindLabel("rule", "en", "work")).toBe("Rule");
    expect(alwaysAllowLabel("rule", "en", "work")).toBe("Always save rules like this");
    expect(suggestionKindLabel("rule", "da", "family")).toBe("Familieregel");
    expect(suggestionKindLabel("mystery")).toBe("Suggestion");
  });
  it("writes Danish durations and possessives", () => {
    expect(workedFor(4200, "da")).toBe("brugte 4 sek.");
    expect(possessive(["Emma"], "da")).toBe("Emmas ");
    expect(possessive(["Mads"], "da")).toBe("Mads' ");
    expect(possessive(["Emma", "Noah"], "da")).toBe("Emma og Noahs ");
    expect(dayPhrase(new Date("2026-11-07T07:00:00Z"), now, TZ, "da")).toBe("på lørdag");
    expect(dayPhrase(new Date("2026-11-24T07:30:00Z"), now, TZ, "da")).toBe("den 24. nov");
  });
});

describe("suggested questions by graph kind", () => {
  it("asks family questions in Danish", () => {
    const qs = buildSuggestedQuestions(input({
      locale: "da",
      children: [{ name: "Emma" }],
      events: [{ label: "Udflugt til Zoo", startAt: new Date("2026-11-05T07:30:00Z"), people: ["Emma"] }],
    })).map((q) => q.q);
    expect(qs[0]).toBe("Hvad skal vi have med til Emmas udflugt til Zoo i morgen?");
  });

  it("never talks about school, packing or children outside a family graph", () => {
    const qs = buildSuggestedQuestions(input({
      graphKind: "work",
      children: [{ name: "Emma" }],
      events: [{ label: "Steering group", startAt: new Date("2026-11-05T09:00:00Z"), people: [] }],
      reminders: [{ title: "Send the roadmap", dueAt: new Date("2026-11-06T09:00:00Z"), about: null }],
      sources: [{ title: "school-letter.pdf", createdAt: new Date("2026-11-03T10:00:00Z") }],
      templatePrompts: getTemplate("work").prompts,
    }), 10).map((q) => q.q);
    expect(qs[0]).toBe("What do I need to prepare for steering group tomorrow?");
    expect(qs).toContain("What is due in the next two weeks?");
    expect(qs).toContain("Summarise what was added this week");
    expect(qs).toContain(getTemplate("work").prompts[0]);
    expect(qs.some((q) => /school|Emma|pack|tomorrow\?$/i.test(q) && !q.startsWith("What do I need to prepare"))).toBe(false);
  });

  it("offers the template's examples in a quiet graph", () => {
    const prompts = getTemplate("project").prompts;
    const qs = buildSuggestedQuestions(input({ graphKind: "project", templatePrompts: prompts })).map((q) => q.q);
    expect(qs).toEqual([...prompts.slice(0, 3), "What's in this graph so far?"]);
  });

  it("writes a generic tip and examples outside a family graph", () => {
    const tip = specificTip(input({ graphKind: "work", events: [{ label: "Budget review", startAt: new Date("2026-11-05T09:00:00Z"), people: ["Lars"] }] }));
    expect(tip.after).toBe("What do I need to prepare for budget review tomorrow, and is anything still open?");
    expect(buildOnboardingExamples(input({ graphKind: "work", locale: "da" }))).toEqual([
      "Hvad er der i grafen indtil videre?", "Hvem er med i grafen indtil videre?", "Hvad kan du hjælpe mig med her?",
    ]);
  });
});

describe("brief prompt", () => {
  const base = { now, tz: TZ, viewerName: "Anna", children: [], events: [], reminders: [], facts: [], failedUploads: [] };
  const ctx = { text: "", citations: [], sensitive: false, empty: true };
  it("is generic outside a family graph and asks for Danish when the reader reads Danish", () => {
    const [sys, user] = buildBriefMessages({ ...base, graphKind: "work", graphNoun: "work graph", locale: "da" }, ctx);
    expect(sys.content).not.toMatch(/parent|family/i);
    expect(sys.content).toContain("Write in Danish");
    expect(sys.content).toContain("\"I morgen:\"");
    expect(user.content).toContain("Reader: Anna.");
  });
  it("keeps the family framing in a family graph", () => {
    const [sys] = buildBriefMessages({ ...base, graphKind: "family" }, ctx);
    expect(sys.content).toContain("busy parent");
    expect(sys.content).toContain("Write in English");
  });
});
