import { describe, expect, it } from "vitest";
import { importerForFile } from "./registry";
import { isOccasionAlbum, photosImporter, readPhotos } from "./photos";
import { distanceM, fmtRange, townOf } from "./geo";
import type { PhotosPayload } from "./schemas";
import type { ImportContext, ImportKnown } from "./types";

const HOME = { lat: 55.6761, lon: 12.5683 }; // Copenhagen
const ROME = { lat: 41.9028, lon: 12.4964 };
const ZOO = { lat: 55.8, lon: 12.9 }; // ~25 km away

function ctx(known: ImportKnown[] = [], locale: "en" | "da" = "en"): ImportContext {
  let n = 0;
  return { sourceId: "src", graphKind: "family", visibility: "private", known, existingEdges: new Set(), now: new Date("2025-01-01"), mint: () => `m${++n}`, locale };
}

type P = PhotosPayload["photos"][number];
const photo = (id: string, day: string, at: { lat: number; lon: number } | null, extra: Partial<P> = {}): P =>
  ({ id, takenAt: `${day}T12:00:00+02:00`, ...(at ? { lat: at.lat + Math.random() * 1e-4, lon: at.lon } : {}), albums: [], ...extra });

/** Photos at home on 10 different days. */
const homeDays = (): P[] => Array.from({ length: 10 }, (_, i) => photo(`h${i}`, `2024-03-${String(i + 1).padStart(2, "0")}`, HOME));

describe("geo helpers", () => {
  it("measures, formats and finds towns", () => {
    expect(Math.round(distanceM(HOME, ROME) / 1000)).toBe(1532);
    expect(fmtRange("2024-05-03", "2024-05-07", "en")).toBe("3–7 May 2024");
    expect(fmtRange("2024-04-28", "2024-05-02", "da")).toBe("28. april – 2. maj 2024");
    expect(townOf("Via del Corso 12, 00186 Roma RM, Italy")).toBe("Roma");
    expect(townOf("Vesterbrogade 3, 1620 København V, Denmark")).toBe("København V");
    expect(townOf("Somewhere")).toBeNull();
  });
});

describe("photos importer", () => {
  it("knows trip albums from system albums", () => {
    expect(isOccasionAlbum("Rome 2024")).toBe(true);
    expect(isOccasionAlbum("Sommerferie")).toBe(true);
    expect(isOccasionAlbum("Recents")).toBe(false);
    expect(isOccasionAlbum("Screenshots")).toBe(false);
    expect(isOccasionAlbum("Cats")).toBe(false);
  });

  it("detects only the app's own batch", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(photosImporter.detect({ filename: "photos.json", head: enc('{"photos":[{"id":"A"}]}') })).toBe(true);
    expect(photosImporter.detect({ filename: "x.json", head: enc('{"photo":1}') })).toBe(false);
    expect(importerForFile("photos.json", enc('{"photos":[{"id":"A"}]}'))?.id).toBe("photos");
  });

  it("proposes a trip for days in a row far from the usual places, named by the phone's place names", () => {
    const rome = ["2024-05-03", "2024-05-04", "2024-05-05"].flatMap((d, i) => Array.from({ length: 5 }, (_, j) => photo(`r${i}${j}`, d, ROME, { placeName: "Rome" })));
    const plan = readPhotos({ photos: [...homeDays(), ...rome] }, ctx());
    const events = plan.changes.filter((c) => c.op === "addNode");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "event", kind: "trip", label: "Trip to Rome", startAt: "2024-05-03T00:00:00.000Z", endAt: "2024-05-05T23:59:59.000Z" });
    expect(events[0].receipt?.quote).toContain("Trip to Rome");
    expect(plan.counts).toMatchObject({ photos: 25, trips: 1, events: 1 });
    expect(plan.segments.map((s) => s.text).join("\n")).toContain("Trip to Rome");
  });

  it("an album named like a trip becomes the event (instead of a detected trip), in Danish too", () => {
    const rome = ["2024-05-03", "2024-05-04"].flatMap((d, i) => Array.from({ length: 4 }, (_, j) => photo(`r${i}${j}`, d, ROME, { albums: ["Rom 2024", "Recents"] })));
    const plan = readPhotos({ photos: [...homeDays(), ...rome] }, ctx([], "da"));
    const events = plan.changes.filter((c) => c.op === "addNode");
    expect(events.map((e) => (e as { label: string }).label)).toEqual(["Rom 2024"]);
    expect(events[0]).toMatchObject({ kind: "trip" });
  });

  it("a day out needs many photos at one spot away from home, and links the known place there", () => {
    const zoo: ImportKnown = { id: "zoo", type: "place", kind: null, label: "Zoo", aliases: [], startAt: null, props: { lat: ZOO.lat, lon: ZOO.lon } };
    const few = Array.from({ length: 5 }, (_, j) => photo(`z${j}`, "2024-06-01", ZOO));
    expect(readPhotos({ photos: [...homeDays(), ...few] }, ctx([zoo])).changes).toEqual([]);
    const many = Array.from({ length: 14 }, (_, j) => photo(`z${j}`, "2024-06-01", ZOO));
    const plan = readPhotos({ photos: [...homeDays(), ...many] }, ctx([zoo]));
    expect(plan.changes[0]).toMatchObject({ op: "addNode", label: "Day at Zoo", kind: null });
    expect(plan.changes[1]).toMatchObject({ op: "addEdge", relation: "happened_at", toId: "zoo" });
  });

  it("does not propose an event the graph already has, and never names the usual places", () => {
    const rome = ["2024-05-03", "2024-05-04"].flatMap((d, i) => Array.from({ length: 5 }, (_, j) => photo(`r${i}${j}`, d, ROME, { placeName: "Rome" })));
    const known: ImportKnown = { id: "e", type: "event", kind: "trip", label: "Italy", aliases: [], startAt: "2024-05-02T00:00:00Z", props: { endAt: "2024-05-06T00:00:00Z" } };
    const plan = readPhotos({ photos: [...homeDays(), ...rome] }, ctx([known]));
    expect(plan.changes).toEqual([]);
    expect(plan.changes.some((c) => c.op === "addNode" && c.type === "place")).toBe(false);
  });

  it("links uploaded photos to their event and to known places within 150 m", () => {
    const doc = (sid: string): ImportKnown => ({ id: `doc-${sid}`, type: "document", kind: null, label: "IMG", aliases: [], startAt: null, props: { sourceId: sid } });
    const sid = "6f1c1f4e-8c1a-4a35-9d7d-3b4a1f0e2a11";
    const tivoli: ImportKnown = { id: "tivoli", type: "place", kind: null, label: "Tivoli", aliases: [], startAt: null, props: { lat: HOME.lat, lon: HOME.lon } };
    const photos = [...homeDays(), photo("h-up", "2024-03-02", HOME, { sourceId: sid })];
    const plan = readPhotos({ photos }, ctx([doc(sid), tivoli]));
    expect(plan.changes).toEqual([expect.objectContaining({ op: "addEdge", fromId: `doc-${sid}`, toId: "tivoli", relation: "located_at" })]);
    expect(plan.counts.placeLinks).toBe(1);
  });

  it("with no usual places (a small batch) it proposes no trips or days out", () => {
    const rome = Array.from({ length: 20 }, (_, j) => photo(`r${j}`, "2024-05-03", ROME));
    expect(readPhotos({ photos: rome }, ctx()).changes).toEqual([]);
  });
});
