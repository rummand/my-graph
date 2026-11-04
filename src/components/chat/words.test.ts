import { describe, expect, it } from "vitest";
import { makeT } from "@/lib/i18n/core";
import enChat from "@/lib/i18n/messages/en/chat";
import daChat from "@/lib/i18n/messages/da/chat";
import enMention from "@/lib/i18n/messages/en/mention";
import daMention from "@/lib/i18n/messages/da/mention";
import { durationWords, resultWords, stepWords, tagWords, workedWords } from "./words";
import { groupByRecency, groupForInbox, locatorWords, starterQuestions, templateStarters } from "./recency";
import { TEMPLATES } from "@/lib/templates/templates";

const da = makeT("da", { chat: daChat }, { chat: enChat });

/** Every key path with a string or plural leaf. */
function keys(tree: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(tree).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") return [path];
    if (v && typeof v === "object" && "one" in v && "other" in v) return [path];
    return keys(v as Record<string, unknown>, path);
  });
}

describe("chat and mention messages", () => {
  it("Danish has every English key, and nothing extra", () => {
    expect(keys(daChat).sort()).toEqual(keys(enChat).sort());
    expect(keys(daMention).sort()).toEqual(keys(enMention).sort());
  });
});

describe("stepWords", () => {
  it("keeps English as stored", () => {
    expect(stepWords("Read 3 documents")).toBe("Read 3 documents");
    expect(stepWords("Recalled 2 family rules and 1 preference")).toBe("Recalled 2 family rules and 1 preference");
  });
  it("translates stored step labels to Danish", () => {
    expect(stepWords("Read 1 document", da)).toBe("Læste 1 dokument");
    expect(stepWords("Looked up 2 people", da)).toBe("Slog 2 personer op");
    expect(stepWords("Checked the timeline (3 events)", da)).toBe("Tjekkede tidslinjen (3 begivenheder)");
    expect(stepWords("Recalled 2 family rules, 1 preference and 3 notes", da)).toBe("Huskede 2 familieregler, 1 præference og 3 noter");
    expect(stepWords("Skipped the library and People (turned off in Assistant settings)", da)).toBe("Sprang biblioteket og Personer over (slået fra i assistentens indstillinger)");
    expect(stepWords("Proposed 1 change for approval", da)).toBe("Foreslog 1 ændring til godkendelse");
  });
  it("says rules, not family rules, outside a family graph", () => {
    expect(stepWords("Recalled 2 family rules", undefined, { family: false })).toBe("Recalled 2 rules");
  });
  it("leaves unknown labels alone", () => {
    expect(stepWords("Did something new", da)).toBe("Did something new");
    expect(stepWords("Recalled a feeling", da)).toBe("Recalled a feeling");
  });
});

describe("durations and the worked line", () => {
  it("words durations in both languages", () => {
    expect(durationWords(400)).toBe("under a second");
    expect(durationWords(4200)).toBe("4s");
    expect(durationWords(65_000)).toBe("1 min 5s");
    expect(durationWords(4200, da)).toBe("4 s");
    expect(workedWords(4200, [{ kind: "search", label: "a" }, { kind: "read", label: "b" }])).toBe("Worked for 4s, 2 steps");
    expect(workedWords(null, [], da)).toBe("Arbejdede");
  });
});

describe("resultWords and tagWords", () => {
  it("translates proposal results", () => {
    expect(resultWords("Remembered: Reminders the evening before", da)).toBe("Husket: Reminders the evening before");
    expect(resultWords("Reminder added for Thu 5 Nov: Pay rent", da)).toBe("Påmindelse tilføjet til Thu 5 Nov: Pay rent");
    expect(resultWords(null, da)).toBe("Gemt");
    expect(resultWords("Something else")).toBe("Something else");
  });
  it("translates highlight tags", () => {
    expect(tagWords("links to Emma", da)).toBe("henviser til Emma");
    expect(tagWords("new kind: Department", da)).toBe("ny slags: Department");
    expect(tagWords("new person", da)).toBe("ny person");
    expect(tagWords("new Project", da)).toBe("nyt projekt");
    expect(tagWords("new Afdeling", da)).toBe("ny Afdeling");
  });
});

describe("recency and starters in Danish", () => {
  const now = new Date(2026, 10, 18, 15, 0);
  const at = (y: number, m: number, d: number) => new Date(y, m, d, 12).toISOString();
  it("groups with Danish labels and month names", () => {
    const g = groupByRecency([{ id: "a", updatedAt: at(2026, 10, 18) }, { id: "b", updatedAt: at(2026, 9, 2) }, { id: "c", updatedAt: at(2025, 2, 4) }], now, { t: da, locale: "da" });
    expect(g.map((x) => x.label)).toEqual(["I dag", "Oktober", "Marts 2025"]);
    expect(groupForInbox([{ id: "p", updatedAt: at(2026, 1, 1), pinned: true }], now, { t: da, locale: "da" })[0].label).toBe("Fastgjort");
  });
  it("writes family starters in Danish", () => {
    const s = starterQuestions([{ id: "e", name: "Emma Jensen", kind: "child" }], da);
    expect(s[0].question).toBe("Hvad skal Emma i denne uge?");
  });
  it("uses the template's prompts outside a family graph, translated only while they match", () => {
    const work = templateStarters("work", TEMPLATES.work.prompts, da);
    expect(work.map((x) => x.question).some((q) => /Aula/.test(q))).toBe(false);
    expect(work[1].question).toBe("Hvem arbejder på hvilket projekt?");
    expect(templateStarters("work", ["Something the template now says"], da)[0].question).toBe("Something the template now says");
    expect(templateStarters("other", [], da).length).toBe(3);
  });
  it("our English starters match every template's prompts", () => {
    for (const kind of ["personal", "work", "partner", "project", "shared", "other"] as const) {
      expect(templateStarters(kind, TEMPLATES[kind].prompts).map((x) => x.question)).toEqual(TEMPLATES[kind].prompts.slice(0, 5));
      const translated = templateStarters(kind, TEMPLATES[kind].prompts, da).map((x) => x.question);
      expect(translated.every((q, i) => q !== TEMPLATES[kind].prompts[i])).toBe(true);
    }
  });
  it("words locators in Danish", () => {
    expect(locatorWords({ page: 3 }, da)).toBe("side 3");
    expect(locatorWords({ timeStartSec: 80, timeEndSec: 95 }, da)).toBe("1:20 til 1:35");
  });
});
