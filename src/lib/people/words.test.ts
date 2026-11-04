import { describe, expect, it } from "vitest";
import { makeT } from "@/lib/i18n/core";
import { DICTIONARIES } from "@/lib/i18n/messages";
import { BUILTIN_KINDS, BUILTIN_RELATIONS } from "@/lib/meta/builtins";
import { mergeMetaModel } from "@/lib/meta/model";
import { getTemplate } from "@/lib/templates/templates";
import { makeFmt } from "./fmt";
import { circleIn, layoutCircles, ringOf, ringsFor } from "./circles";
import { localizeDetails, localizeError } from "./errors";
import { relationsToCenter, relationToYouParts, type PathEdge, type PathNode } from "./relpath";
import { attrName, circleName, kindHelp, kindName, localRings, relLabel, rolePhrase, visibilityName, wellbeingWord, whose } from "./words";

const en = makeT("en", DICTIONARIES.en, DICTIONARIES.en);
const da = makeT("da", DICTIONARIES.da, DICTIONARIES.en);

const meta = mergeMetaModel("hh", {
  kinds: BUILTIN_KINDS.map((k, i) => ({ id: `k${i}`, householdId: null, nodeType: k.nodeType, key: k.key, label: k.label, pluralLabel: null, description: null, circle: k.circle ?? null, parentKey: null, icon: null, color: null, sortOrder: i, builtin: true })),
  relations: BUILTIN_RELATIONS.map((r, i) => ({ id: `r${i}`, householdId: null, key: r.key, label: r.label, inverseLabel: r.inverseLabel, category: r.category, fromTypes: r.fromTypes, toTypes: r.toTypes, symmetric: !!r.symmetric, builtin: true })),
  attributes: [],
});

describe("relation phrases in the reader's language", () => {
  const nodes = new Map<string, PathNode>([
    ["me", { id: "me", label: "Anna", type: "person", kind: "parent" }],
    ["emma", { id: "emma", label: "Emma", type: "person", kind: "child" }],
    ["mette", { id: "mette", label: "Mette", type: "person", kind: "teacher" }],
    ["bo", { id: "bo", label: "Bo", type: "person", kind: null }],
    ["jens", { id: "jens", label: "Jens", type: "person", kind: null }],
  ]);
  const edges: PathEdge[] = [
    { id: "1", fromId: "me", toId: "emma", relation: "parent_of", status: "confirmed" },
    { id: "2", fromId: "mette", toId: "emma", relation: "teacher_of" },
    { id: "3", fromId: "me", toId: "bo", relation: "works_with" },
    { id: "4", fromId: "jens", toId: "emma", relation: "friend_of" },
  ];
  const rel = relationsToCenter(meta, "me", nodes, edges, { centerIsViewer: true });
  const say = (t: typeof en, locale: "en" | "da", id: string) => rolePhrase(t, locale, rel.get(id)!.role, rel.get(id)!.label);

  it("keeps the English sentence in English", () => {
    expect(say(en, "en", "emma")).toBe("Your child");
    expect(say(en, "en", "mette")).toBe("Emma's teacher");
    expect(say(en, "en", "bo")).toBe("Works with you");
  });
  it("says it in natural Danish, with Danish possessives", () => {
    expect(say(da, "da", "emma")).toBe("Dit barn");
    expect(say(da, "da", "mette")).toBe("Emmas lærer");
    expect(say(da, "da", "bo")).toBe("Arbejder sammen med dig");
    expect(say(da, "da", "jens")).toBe("Emmas ven");
  });
  it("words a relation to you from the other side", () => {
    const parts = relationToYouParts(meta, edges[0], nodes.get("emma")!);
    expect(rolePhrase(da, "da", parts, "Your child")).toBe("Dit barn");
  });
  it("falls back to the English sentence for labels a household made up", () => {
    expect(rolePhrase(da, "da", { noun: "godmother", verb: "godmother of", anchor: null }, "Your godmother")).toBe("Your godmother");
    expect(rolePhrase(da, "da", null, "Your child")).toBe("Your child");
  });
  it("forms possessives per language", () => {
    expect(whose("Emma", "en")).toBe("Emma's");
    expect(whose("Jens", "en")).toBe("Jens'");
    expect(whose("Emma", "da")).toBe("Emmas");
    expect(whose("Jens", "da")).toBe("Jens'");
  });
});

describe("model labels", () => {
  it("translates built-in kinds, relations and attributes, and leaves renamed ones alone", () => {
    expect(kindName(da, "Teacher")).toBe("Lærer");
    expect(kindName(da, "Our coach")).toBe("Our coach");
    expect(kindName(en, "Teacher")).toBe("Teacher");
    expect(relLabel(da, "child of")).toBe("barn af");
    expect(attrName(da, "Birthday")).toBe("Fødselsdag");
    expect(attrName(da, "Rate per hour (kr.)")).toBe("Rate per hour (kr.)");
  });
  it("translates a kind's description only while it is the built-in one", () => {
    const teacher = BUILTIN_KINDS.find((k) => k.key === "teacher")!;
    expect(kindHelp(da, "teacher", teacher.description)).toMatch(/^Lærer, også/);
    expect(kindHelp(da, "teacher", "Our own words")).toBe("Our own words");
  });
  it("words wellbeing and visibility", () => {
    expect(wellbeingWord(da, 1)).toBe("Har det svært");
    expect(wellbeingWord(en, 5)).toBe("Thriving");
    expect(visibilityName(en, true, "household")).toBe("Whole household");
    expect(visibilityName(en, false, "parents")).toBe("Owner and editors");
    expect(visibilityName(da, false, "household")).toBe("Alle i denne graf");
  });
});

describe("circles per graph", () => {
  it("draws the family rings in a family graph and the template's circles elsewhere", () => {
    expect(ringsFor("family").map((r) => r.key)).toEqual(["family", "close", "school_care", "social", "work", "other"]);
    expect(ringsFor("work").map((r) => r.key)).toEqual(["team", "manager", "clients", "partners", "network"]);
    expect(ringsFor("nonsense").map((r) => r.key)).toEqual(["close", "work", "other"]);
  });
  it("moves a circle the graph doesn't use to its nearest one", () => {
    const work = getTemplate("work"), partner = getTemplate("partner"), family = getTemplate("family");
    expect(circleIn(work, "work")).toBe("team");
    expect(circleIn(work, "family")).toBe("network");
    expect(circleIn(work, "clients")).toBe("clients");
    expect(circleIn(partner, "social")).toBe("friends");
    expect(circleIn(partner, "work")).toBe("places");
    expect(circleIn(family, "team")).toBe("other");
  });
  it("names circles in the graph's own words", () => {
    expect(circleName(en, "family", "close")).toBe("Close friends");
    expect(circleName(en, "personal", "close")).toBe("Close");
    expect(circleName(da, "family", "close")).toBe("Nære venner");
    expect(circleName(da, "work", "manager")).toBe("Ledere");
    expect(circleName(da, "family", "school_care")).toBe("Skole, institution og sundhed");
  });
  it("lays out a work graph on its own rings", () => {
    const rings = localRings(da, "work", ringsFor("work"));
    const l = layoutCircles([{ id: "a", circle: "team", r: 30 }, { id: "b", circle: "clients", r: 30 }, { id: "c", circle: "weird", r: 30 }], { rings, simulate: false });
    expect(l.rings.map((r) => r.label)).toEqual(["Team", "Kunder", "Netværk"]);
    expect(ringOf("weird", rings)).toBe(rings.length - 1);
  });
});

describe("dates and spans", () => {
  const now = new Date("2026-11-04T10:00:00Z");
  const fda = makeFmt(da, "da", "Europe/Copenhagen");
  const fen = makeFmt(en, "en", "Europe/Copenhagen");
  it("says when in each language", () => {
    expect(fen.ago("2026-11-03T10:00:00Z", now)).toBe("yesterday");
    expect(fda.ago("2026-11-03T10:00:00Z", now)).toBe("i går");
    expect(fda.ago("2026-10-30T10:00:00Z", now)).toBe("5 dage siden");
    expect(fda.ago(null)).toBe("aldrig");
    expect(fda.inDays(3)).toBe("om 3 dage");
    expect(fda.daysWords(75)).toBe("3 måneder");
    expect(fen.daysWords(1)).toBe("1 day");
  });
  it("formats calendar dates as that day, whatever the zone", () => {
    expect(fen.dayLabel("2026-11-08")).toMatch(/Sun 8 Nov/);
    expect(fda.dayLabel("2026-11-08")).toMatch(/8\. nov/);
  });
});

describe("API errors", () => {
  it("are said in Danish, field issues too", () => {
    expect(localizeError(da, "Person not found")).toBe("Personen blev ikke fundet");
    expect(localizeError(da, "You can look at this graph but can't add people in it")).toBe("Du kan se denne graf, men ikke tilføje personer i den");
    expect(localizeError(da, "Something new")).toBe("Something new");
    expect(localizeDetails(da, { fields: [{ key: "kind", message: "Pick a kind from the list" }] })).toEqual({ fields: [{ key: "kind", message: "Vælg en type fra listen" }] });
    expect(localizeError(en, "Person not found")).toBe("Person not found");
  });
});
