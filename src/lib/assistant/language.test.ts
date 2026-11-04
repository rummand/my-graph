/**
 * What the server and the assistant write for a person: in their language, and about the graph by its kind.
 * Family wording never appears outside a family graph.
 */
import { describe, expect, it } from "vitest";
import { DICTIONARIES } from "@/lib/i18n/messages";
import type { MessageTree } from "@/lib/i18n/core";
import { buildHeartbeatProposals, heartbeatSummary, type HeartbeatData } from "@/lib/automations/heartbeat-pure";
import { composeReport, reportHeadline } from "@/lib/keeper/pure";
import { keeperSystemPrompt } from "@/lib/keeper/prompt";
import { numberContext, type ContextItem } from "./context";
import { degradedAnswer, deterministicSummary } from "./fallback";
import { planUnattended, skippedLine, suggestionTitle } from "./policy";
import { buildMessages, languageUnclear, systemPrompt } from "./prompt";
import type { Proposal } from "./proposals";
import { wideningWarning } from "./sensitivity";
import { memoryStep } from "./steps";
import { tPure, voiceFor } from "./voice";

const FAMILY_WORDS = /famil|household|\bparents?\b|\bchild(ren)?\b|\bkids?\b|aula|grandma|forældre|\bbørn/i;
const NON_FAMILY = ["work", "partner", "personal", "project", "shared", "other"] as const;

const base = { viewerName: "Anna", today: "Wednesday 4 November 2026", timeZone: "Europe/Copenhagen" };
const fact: ContextItem = { kind: "fact", edgeId: "e1", fromId: "n1", title: "Emma works on Atlas", status: "inferred", confidence: 0.5, sources: [], sensitive: false } as unknown as ContextItem;
const passage: ContextItem = { kind: "passage", sourceId: "s1", title: "Kick-off notes", text: "Launch on Friday", locator: {}, sensitive: false } as unknown as ContextItem;

describe("chat prompt framing per graph kind", () => {
  for (const kind of NON_FAMILY) {
    for (const locale of ["en", "da"] as const) {
      it(`has no family wording in a ${kind} graph (${locale})`, () => {
        const opts = { ...base, graphKind: kind, graphName: "Acme", locale, memory: "- No meetings before 10", off: ["the library"], canRemember: true };
        const p = systemPrompt(opts);
        expect(p).not.toMatch(FAMILY_WORDS);
        const msgs = buildMessages({ ...opts, context: "[1] Source: x", history: [], question: "What is due?" });
        expect(msgs.map((m) => String(m.content)).join("\n")).not.toMatch(FAMILY_WORDS);
      });
    }
  }
  it("names the graph by its kind", () => {
    expect(systemPrompt({ ...base, graphKind: "work", graphName: "Acme" })).toContain('your work graph ("Acme")');
    expect(systemPrompt({ ...base, graphKind: "partner" })).toContain("your shared graph");
  });
  it("keeps the family framing in a family graph", () => {
    const p = systemPrompt({ ...base, graphKind: "family", memory: "- Sunday dinner" });
    expect(p).toContain("family assistant");
    expect(p).toContain("Family rules and preferences");
  });
  it("answers in the question's language, falling back to the person's", () => {
    const da = systemPrompt({ ...base, graphKind: "work", locale: "da" });
    expect(da).toContain("reply in the language of the user's latest message");
    expect(da).toContain("reply in Danish, Anna's chosen language");
    expect(systemPrompt({ ...base, graphKind: "work", locale: "en" })).toContain("reply in English");
  });
  it("answers a question too short to tell in the person's language", () => {
    expect(languageUnclear("SAP?")).toBe(true);
    expect(languageUnclear("Emma Larsen")).toBe(true);
    expect(languageUnclear("https://example.com/x")).toBe(true);
    expect(languageUnclear("What is due this week?")).toBe(false);
    expect(languageUnclear("Hvornår er mødet?")).toBe(false);
    const short = buildMessages({ ...base, graphKind: "work", locale: "da", context: "", history: [], question: "SAP?" });
    expect(String(short[0].content)).toContain("Write this answer in Danish");
    const long = buildMessages({ ...base, graphKind: "work", locale: "da", context: "", history: [], question: "When does SAP support end?" });
    expect(String(long[0].content)).not.toContain("Write this answer in Danish");
  });
  it("writes unattended runs in the person's language whatever the prompt is in", () => {
    const p = systemPrompt({ ...base, graphKind: "work", locale: "da", answerInLocale: true, unattended: true });
    expect(p).toContain("Write in Danish, Anna's chosen language");
    expect(p).not.toContain("reply in the language of the user's latest message");
  });
});

describe("text the server writes", () => {
  it("degraded answers name the graph in the reader's language", () => {
    const items = [passage, fact];
    const da = degradedAnswer("unreachable", numberContext(items), items, voiceFor("work", "da"));
    expect(da).toContain("Jeg kan ikke få fat i modelgatewayen");
    expect(da).toContain("din arbejdsgraf");
    expect(da).toContain("(gæt) [2]");
    expect(da).not.toMatch(FAMILY_WORDS);
    const en = degradedAnswer("unreachable", numberContext([]), [], voiceFor("work", "en"));
    expect(en).toContain("your work graph");
    expect(en).not.toMatch(FAMILY_WORDS);
    expect(degradedAnswer("unreachable", numberContext([]), [])).toContain("your family graph");
  });
  it("run summaries without the model are in the owner's language", () => {
    expect(deterministicSummary([passage], "unreachable", tPure("da")))
      .toBe("Fandt 1 dokument; der blev ikke skrevet et resumé, fordi modelgatewayen ikke kunne nås.");
    expect(deterministicSummary([], null, tPure("da"))).toBe("Fandt ikke noget nyt.");
  });
  it("calls rules just rules outside a family graph", () => {
    expect(memoryStep({ rules: 2, preferences: 0, notes: 0 }, { family: false })?.label).toBe("Recalled 2 rules");
    expect(memoryStep({ rules: 2, preferences: 0, notes: 0 }, { family: true })?.label).toBe("Recalled 2 family rules");
  });
  it("writes suggestion titles and skipped lines in Danish", () => {
    const r: Proposal = { type: "propose_reminder", title: "Send rapporten", dueAt: "2026-11-05T09:00:00+01:00", aboutPerson: null, detail: null, basis: null };
    const rule: Proposal = { type: "propose_memory", kind: "rule", text: "Ingen møder før kl. 10", about: [], quote: null, basis: null };
    const da = tPure("da");
    expect(suggestionTitle(r, da)).toBe("Tilføj påmindelse: Send rapporten");
    expect(suggestionTitle(rule, da, false)).toBe("Husk denne regel: Ingen møder før kl. 10");
    expect(suggestionTitle(rule, da, true)).toBe("Husk denne familieregel: Ingen møder før kl. 10");
    expect(skippedLine(r, true, da)).toBe("Påmindelse: Send rapporten: venter på godkendelse under Forslag");
    const plan = planUnattended([r], { capabilities: { reminders: false }, memoryAllowed: true, t: da });
    expect(plan.skipped[0]).toBe("Påmindelse: Send rapporten: ikke foreslået, påmindelser er slået fra");
  });
  it("warns about widening without children outside a family graph", () => {
    const w = wideningWarning("parents", "household", voiceFor("work", "en"));
    expect(w).toContain("everyone in this graph");
    expect(w).not.toMatch(FAMILY_WORDS);
    expect(wideningWarning("parents", "household", voiceFor("family", "da"))).toContain("også børnene");
  });
});

describe("heartbeat nudges in Danish", () => {
  const now = new Date("2026-11-04T09:00:00Z");
  const empty: HeartbeatData = { uploads: [], dueSoon: [], overdue: [], birthdays: [], outOfTouch: [], facts: { edges: [], total: 0 }, reminderTitles: [] };
  const caps = { library: true, people: true, reminders: true };
  const t = tPure("da");
  it("writes titles, bodies and button labels in the owner's language", () => {
    const d: HeartbeatData = {
      ...empty,
      overdue: [{ id: "r1", title: "Budget", dueAt: now, aboutLabel: null }, { id: "r2", title: "Kontrakt", dueAt: now, aboutLabel: null }],
      uploads: [{ id: "s1", title: "Referat", createdAt: now }],
      birthdays: [{ personId: "p1", label: "Mette", date: new Date("2026-11-09T00:00:00Z"), daysUntil: 5, turning: 40 }],
      outOfTouch: [{ personId: "p2", label: "Jonas", daysSince: 40, cadenceDays: 30 }],
    };
    const p = buildHeartbeatProposals(d, { now, tz: "Europe/Copenhagen", capabilities: caps, t });
    expect(p[0].title).toBe("2 påmindelser er forfaldne");
    expect(p[0].body).toBe("Budget og Kontrakt. Sæt flueben ved dem på I dag, eller flyt dem til en ny dato.");
    expect(p[0].payload.label).toBe("Åbn I dag");
    expect(p[1].title).toBe("Nyt i biblioteket: Referat");
    expect(p[2].title).toBe("Tilføj en påmindelse om Mettes fødselsdag");
    expect(p[2].body).toContain("Mette har fødselsdag om 5 dage og bliver 40.");
    expect(p[2].payload.title).toBe("Fødselsdag for Mette (40): gave eller opkald");
    expect(p[3].title).toBe("Det er et stykke tid siden, du har været i kontakt med Jonas");
    expect(p[3].body).toBe("40 dage siden I sidst var i kontakt; normalt er det cirka hver 30. dag.");
    for (const x of p) expect(`${x.title} ${x.body ?? ""}`).not.toMatch(/\b(the|and|is|Open|Overdue|birthday)\b/);
  });
  it("summarises the check-in in Danish", () => {
    expect(heartbeatSummary(0, 0, empty, t)).toBe("Intet kræver din opmærksomhed lige nu.");
    const d = { ...empty, overdue: [{ id: "r1", title: "Budget", dueAt: now, aboutLabel: null }] };
    expect(heartbeatSummary(1, 0, d, t)).toBe("Fandt 1 forfalden påmindelse. Lagde 1 forslag i din indbakke.");
  });
  it("keeps the English text as before", () => {
    const d = { ...empty, overdue: [{ id: "r1", title: "Permission slip", dueAt: now, aboutLabel: null }] };
    expect(buildHeartbeatProposals(d, { now, tz: "Europe/Copenhagen", capabilities: caps })[0].title).toBe("Overdue: Permission slip");
  });
});

describe("Brain Keeper report", () => {
  it("is written in the person's language", () => {
    const da = tPure("da");
    expect(reportHeadline([], da)).toBe("Intet nyt at huske siden sidste kørsel.");
    const r = composeReport({ conversations: 2, sources: 1 }, [{ action: "x", reason: "No such memory." }], { t: da, degraded: true });
    expect(r).toContain("Læste 2 samtaler, 1 nyt element i biblioteket.");
    expect(r).toContain("Holdt 1 ændring tilbage: Mindet findes ikke.");
    expect(r).toContain("Modelgatewayen (mux) kunne ikke nås");
  });
  it("asks for the report in the person's language and keeps family words out of a work graph", () => {
    const p = keeperSystemPrompt({ graphName: "Acme", graphKind: "work", personName: "Anna", memories: [], locale: "da" });
    expect(p).toContain("in Danish, Anna's chosen language");
    expect(p).not.toMatch(/famil/i);
  });
});

describe("messages", () => {
  const keys = (t: MessageTree, prefix = ""): string[] => Object.entries(t).flatMap(([k, v]) =>
    typeof v === "string" || ("one" in (v as object) && "other" in (v as object)) ? [`${prefix}${k}`] : keys(v as MessageTree, `${prefix}${k}.`));
  it.each([["chat", "server"], ["automations", "server"], ["memory", "keeper"]])("%s.%s has every key in Danish", (ns, group) => {
    const en = keys((DICTIONARIES.en[ns] as MessageTree)[group] as MessageTree);
    const da = new Set(keys((DICTIONARIES.da[ns] as MessageTree)[group] as MessageTree));
    expect(en.filter((k) => !da.has(k))).toEqual([]);
  });
});
