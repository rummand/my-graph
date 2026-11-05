import { describe, expect, it } from "vitest";
import {
  buildExtractionMessages, clampConfidence, edgeStatusFor, findQuoteChunk, matchKnownPerson, morningOf, parseExtraction, reminderDueAt,
} from "./extraction";

describe("parseExtraction", () => {
  it("accepts a well-formed answer and normalises it", () => {
    const r = parseExtraction({
      entities: [
        { type: "Person", label: " Emma ", aliases: ["Em", " "], summary: "" },
        { type: "event", label: "Skolefoto", startAt: "2026-11-20T09:00:00+01:00", precision: "minute" },
        { type: "place", label: "Vesterbro Skole", startAt: null },
      ],
      facts: [
        { from: "Skolefoto", relation: "involves", to: "Emma", quote: "Emma skal fotograferes", confidence: 0.92 },
        { from: "Skolefoto", relation: "happened at", to: "Vesterbro Skole", quote: "på skolen", confidence: "0.7" },
      ],
    });
    expect(r.dropped).toBe(0);
    expect(r.entities[0]).toMatchObject({ type: "person", label: "Emma", aliases: ["Em"], summary: undefined });
    expect(r.entities[1].startAt).toBeInstanceOf(Date);
    expect(r.entities[1].startAt!.toISOString()).toBe("2026-11-20T08:00:00.000Z");
    expect(r.entities[2].startAt).toBeUndefined();
    expect(r.facts[1]).toMatchObject({ relation: "happened_at", confidence: 0.7 });
  });

  it("drops bad items instead of failing the batch", () => {
    const r = parseExtraction({
      entities: [{ type: "animal", label: "Rex" }, { type: "person", label: "" }, { type: "topic", label: "Football" }, { type: "topic", label: "football" }],
      facts: [
        { from: "A", relation: "loves", to: "B", confidence: 0.9 },
        { from: "A", relation: "knows", to: "a", confidence: 0.9 },
        { from: "Emma", relation: "attends", to: "Football", confidence: 140 },
        { relation: "knows", to: "B" },
      ],
    });
    expect(r.entities.map((e) => e.label)).toEqual(["Football"]); // dedupe is case-insensitive
    expect(r.facts).toHaveLength(1);
    expect(r.facts[0].confidence).toBe(1);
    expect(r.dropped).toBe(5);
  });

  it("ignores an invalid date and a reversed range", () => {
    const r = parseExtraction({ entities: [{ type: "event", label: "Trip", startAt: "next Tuesday", endAt: "2026-01-01" }, { type: "event", label: "Camp", startAt: "2026-06-10", endAt: "2026-06-01" }] });
    expect(r.entities[0].startAt).toBeUndefined();
    expect(r.entities[1].endAt).toBeUndefined();
  });

  it("treats missing arrays as empty but rejects a non-object", () => {
    expect(parseExtraction({})).toEqual({ entities: [], facts: [], roles: [], dropped: 0 });
    expect(() => parseExtraction("nope")).toThrow();
    expect(() => parseExtraction({ entities: "x" })).toThrow();
  });
});

describe("confidence and status", () => {
  it("clamps to [0,1] and handles percents/garbage", () => {
    expect(clampConfidence(-1)).toBe(0);
    expect(clampConfidence(1.4)).toBe(1);
    expect(clampConfidence(85)).toBe(0.85);
    expect(clampConfidence(1000)).toBe(1);
    expect(clampConfidence("abc")).toBe(0.5);
    expect(clampConfidence(undefined)).toBe(0.5);
  });
  it("keeps low-confidence facts unconfirmed", () => {
    expect(edgeStatusFor(0.59)).toBe("unconfirmed");
    expect(edgeStatusFor(0.6)).toBe("confirmed");
  });
});

describe("people and quotes", () => {
  const known = [
    { id: "1", label: "Emma Jensen", aliases: [] },
    { id: "2", label: "Oskar Jensen", aliases: ["Ossi"] },
    { id: "3", label: "Emma Larsen", aliases: [] },
  ];
  it("matches known people by label, alias and unique first name", () => {
    expect(matchKnownPerson("emma jensen", known)?.id).toBe("1");
    expect(matchKnownPerson("Ossi", known)?.id).toBe("2");
    expect(matchKnownPerson("Oskar", known)?.id).toBe("2");
    expect(matchKnownPerson("Emma", known)).toBeUndefined(); // ambiguous
    expect(matchKnownPerson("Karl", known)).toBeUndefined();
  });
  it("finds the chunk a quote came from", () => {
    const group = [{ id: "a", text: "Første afsnit." }, { id: "b", text: "Emma skal  til\ntandlæge den 4. december kl. 10." }];
    expect(findQuoteChunk("emma skal til tandlæge", group)?.id).toBe("b");
    expect(findQuoteChunk("Emma skal til tandlæge den 4. december klokken ti", group)?.id).toBe("b");
    expect(findQuoteChunk("not there at all, nothing", group)).toBeUndefined();
    expect(findQuoteChunk(undefined, group)).toBeUndefined();
  });
  it("puts known people and the text into the prompt", () => {
    const m = buildExtractionMessages({ title: "Brev", text: "Hej Emma", known: known.slice(1), today: new Date("2026-11-03T10:00:00Z"), viewerName: "Mor" });
    expect(m[0].role).toBe("system");
    expect(String(m[0].content)).toContain("involves");
    expect(String(m[1].content)).toContain("Oskar Jensen (also: Ossi)");
    expect(String(m[1].content)).toContain("Today: 2026-11-03");
    expect(String(m[1].content)).toContain("Hej Emma");
  });
});

describe("reminderDueAt", () => {
  const now = new Date("2026-11-03T10:00:00Z");
  it("is two days before when there is time", () => {
    expect(reminderDueAt(new Date("2026-11-10T08:00:00Z"), now)?.toISOString()).toBe("2026-11-08T08:00:00.000Z");
  });
  it("is the morning of the event (07:00 Copenhagen) when less than two days away", () => {
    // Winter: CET = UTC+1 → 07:00 local = 06:00Z
    expect(reminderDueAt(new Date("2026-11-04T13:00:00Z"), now)?.toISOString()).toBe("2026-11-04T06:00:00.000Z");
  });
  it("is now when the event is later today", () => {
    expect(reminderDueAt(new Date("2026-11-03T15:00:00Z"), now)?.toISOString()).toBe(now.toISOString());
  });
  it("is null for past events", () => {
    expect(reminderDueAt(new Date("2026-11-01T15:00:00Z"), now)).toBeNull();
  });
  it("handles summer time", () => {
    expect(morningOf(new Date("2026-07-01T12:00:00Z")).toISOString()).toBe("2026-07-01T05:00:00.000Z");
  });
});
