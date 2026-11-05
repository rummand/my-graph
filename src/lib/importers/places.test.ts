import { describe, expect, it } from "vitest";
import { importerForArchive, importerForFile } from "./registry";
import { isLocationEntry, looksLikeLocationJson, parseLatLng, placesImporter, planPlaces, staysFromPoints, visitsOf, type Visit } from "./places";
import type { ImportContext, ImportKnown, ImportPlan } from "./types";

const HOME = { lat: 55.6761, lon: 12.5683 };
const CAFE = { lat: 55.6800, lon: 12.5800 };
const ROME = { lat: 41.9028, lon: 12.4964 };
const enc = (s: string) => new TextEncoder().encode(s);

function ctx(known: ImportKnown[] = [], locale: "en" | "da" = "en"): ImportContext {
  let n = 0;
  return { sourceId: "src", graphKind: "family", visibility: "private", known, existingEdges: new Set(), now: new Date("2025-01-01"), mint: () => `m${++n}`, locale };
}
const day = (i: number) => `2023-03-${String(i).padStart(2, "0")}`;

/** Takeout's monthly Semantic Location History: home every night, a café some mornings, Rome for three days. */
function semanticMonth(): unknown {
  const pv = (at: { lat: number; lon: number }, start: string, end: string, loc: Record<string, unknown>) => ({
    placeVisit: { location: { latitudeE7: Math.round(at.lat * 1e7), longitudeE7: Math.round(at.lon * 1e7), ...loc }, duration: { startTimestamp: start, endTimestamp: end } },
  });
  const objs: unknown[] = [];
  for (let i = 1; i <= 20; i++) {
    objs.push(pv(HOME, `${day(i)}T18:00:00Z`, `${day(i)}T23:00:00Z`, { placeId: "home-id", address: "Vesterbrogade 3, 1620 København V, Denmark", semanticType: "TYPE_HOME" }));
    if (i % 3 === 0) objs.push(pv(CAFE, `${day(i)}T08:00:00Z`, `${day(i)}T09:00:00Z`, { placeId: "cafe-id", name: "Café Norden", address: "Østergade 61, 1100 København, Denmark" }));
    objs.push({ activitySegment: { distance: 1200 } });
  }
  for (let i = 22; i <= 24; i++) {
    objs.push(pv(ROME, `${day(i)}T09:00:00+01:00`, `${day(i)}T20:00:00+01:00`, { placeId: "hotel-id", name: "Hotel Roma", address: "Via del Corso 12, 00186 Roma RM, Italy" }));
  }
  return { timelineObjects: objs };
}

const labels = (p: ImportPlan, type: string) => p.changes.filter((c) => c.op === "addNode" && c.type === type).map((c) => (c as { label: string }).label);

describe("places: detecting", () => {
  it("recognises each export by its first bytes and nothing else", () => {
    expect(looksLikeLocationJson('{"timelineObjects":[{"placeVisit":{}}]}')).toBe(true);
    expect(looksLikeLocationJson('{\n  "semanticSegments": [{"startTime":"x"}]}')).toBe(true);
    expect(looksLikeLocationJson('{\n  "locations": [{\n    "latitudeE7": 556761000,\n "longitudeE7": 125683000')).toBe(true);
    expect(looksLikeLocationJson('[{"endTime":"2024-01-01T10:00:00.000+01:00","startTime":"2024-01-01T09:00:00.000+01:00","visit":{"topCandidate":{"placeLocation":"geo:55.676100,12.568300"}}}]')).toBe(true);
    expect(looksLikeLocationJson('{"visits":[{"arrival":"2024-01-01T10:00:00Z"}]}')).toBe(true);
    expect(looksLikeLocationJson('{"locations":["Copenhagen"]}')).toBe(false);
    expect(looksLikeLocationJson('[{"startTime":"x","title":"meeting"}]')).toBe(false);
    expect(importerForFile("Timeline.json", enc('{"semanticSegments":[]}'))?.id).toBe("places");
    expect(importerForFile("data.csv", enc('{"semanticSegments":[]}'))).toBeNull();
  });

  it("recognises a Takeout zip by its file names", () => {
    expect(isLocationEntry("Takeout/Location History (Timeline)/Semantic Location History/2023/2023_MARCH.json")).toBe(true);
    expect(isLocationEntry("Takeout/Location History/Records.json")).toBe(true);
    expect(isLocationEntry("Takeout/Drive/2023/2023_MARCH.json")).toBe(false);
    expect(isLocationEntry("Takeout/Location History/Settings.json")).toBe(false);
    expect(importerForArchive("takeout.zip", ["Takeout/archive_browser.html", "Takeout/Location History/Semantic Location History/2023/2023_MARCH.json"])?.id).toBe("places");
    expect(importerForArchive("photos.zip", ["Takeout/Google Photos/IMG_1.jpg"])).toBeNull();
  });

  it("reads coordinates in the newer exports' notations", () => {
    expect(parseLatLng("55.6761°, 12.5683°")).toEqual({ lat: 55.6761, lon: 12.5683 });
    expect(parseLatLng("geo:55.676100,12.568300")).toEqual({ lat: 55.6761, lon: 12.5683 });
    expect(parseLatLng({ latLng: "-33.8688°, 151.2093°" })).toEqual({ lat: -33.8688, lon: 151.2093 });
    expect(parseLatLng("nowhere")).toBeNull();
  });
});

describe("places: reading", () => {
  it("Semantic Location History → named places, the café matched by name, a trip to Roma; home never labelled", () => {
    const cafe: ImportKnown = { id: "cafe", type: "place", kind: null, label: "Café Norden", aliases: [], startAt: null, props: {} };
    const plan = placesImporter.read({
      filename: "takeout.zip", bytes: Buffer.alloc(0),
      entries: [{ name: "Takeout/Location History/Semantic Location History/2023/2023_MARCH.json", bytes: enc(JSON.stringify(semanticMonth())) }],
    }, ctx([cafe])) as ImportPlan;
    // The café is known: only its coordinates are proposed.
    const upd = plan.changes.find((c) => c.op === "updateNode");
    expect(upd).toMatchObject({ nodeId: "cafe", set: { props: { lat: 55.68, lon: 12.58, address: "Østergade 61, 1100 København, Denmark" } } });
    // Home: proposed under its address (as Google names it), never as "Home", with a note for the person.
    const places = plan.changes.filter((c) => c.op === "addNode" && c.type === "place");
    expect(labels(plan, "place")).not.toContain("Home");
    const home = places.find((c) => (c as { props?: Record<string, unknown> }).props?.googlePlaceId === "home-id")!;
    expect(home).toMatchObject({ label: "A place you were 20 times", props: { daysVisited: 20, unnamed: true } });
    expect(home.note).toContain("“Home”");
    expect((home as { kind?: string }).kind).toBeUndefined();
    // Rome: a trip, linked to the hotel it was spent at.
    const trip = plan.changes.find((c) => c.op === "addNode" && c.type === "event")!;
    expect(trip).toMatchObject({ kind: "trip", label: "Trip to Roma", startAt: "2023-03-22T00:00:00.000Z", endAt: "2023-03-24T23:59:59.000Z" });
    const hotel = places.find((c) => (c as { label: string }).label === "Hotel Roma")!;
    expect(plan.changes).toContainEqual(expect.objectContaining({ op: "addEdge", fromId: (trip as { nodeId: string }).nodeId, toId: (hotel as { nodeId: string }).nodeId, relation: "happened_at" }));
    expect(plan.counts).toMatchObject({ trips: 1, matched: 1 });
    // Every op points at a line that says it.
    for (const c of plan.changes) expect(plan.segments.some((s) => s.text.includes(c.receipt!.quote!))).toBe(true);
    expect(plan.segments.map((s) => s.text).join("\n")).toContain("Café Norden");
  });

  it("matches a known place by coordinates within 150 m and proposes nothing new for it", () => {
    const known: ImportKnown = { id: "h", type: "place", kind: "home", label: "Vores hus", aliases: [], startAt: null, props: { lat: 55.6765, lon: 12.5683 } };
    const visits: Visit[] = Array.from({ length: 8 }, (_, i) => ({ start: `${day(i + 1)}T18:00:00Z`, end: `${day(i + 1)}T23:00:00Z`, ...HOME, name: null, address: null, placeId: null, hint: null }));
    const plan = planPlaces(visits, ctx([known]));
    expect(plan.changes).toEqual([]);
    expect(plan.counts.matched).toBe(1);
  });

  it("on-device Timeline.json (Android) and location-history.json (iPhone)", () => {
    const android = {
      semanticSegments: [
        { startTime: "2024-01-01T09:00:00.000+01:00", endTime: "2024-01-01T10:00:00.000+01:00", visit: { topCandidate: { placeId: "A", semanticType: "INFERRED_HOME", placeLocation: { latLng: "55.6761°, 12.5683°" } } } },
        { startTime: "2024-01-01T10:00:00.000+01:00", endTime: "2024-01-01T10:30:00.000+01:00", timelinePath: [{ point: "55.6°, 12.5°", time: "x" }] },
      ],
      userLocationProfile: { frequentPlaces: [{ placeId: "A", placeLocation: "55.6761°, 12.5683°", label: "HOME" }] },
    };
    const a = visitsOf(android);
    expect(a.format).toBe("timeline");
    expect(a.visits).toEqual([expect.objectContaining({ placeId: "A", hint: "home", lat: 55.6761, lon: 12.5683 })]);
    expect(a.frequent).toHaveLength(1);
    const ios = [{ startTime: "2024-01-01T09:00:00.000+01:00", endTime: "2024-01-01T10:00:00.000+01:00", visit: { topCandidate: { placeID: "B", semanticType: "Unknown", placeLocation: "geo:41.902800,12.496400" } } }];
    expect(visitsOf(ios).visits).toEqual([expect.objectContaining({ placeId: "B", lat: 41.9028, lon: 12.4964, hint: null })]);
  });

  it("Records.json raw points become stays of 15 minutes or more", () => {
    const pts = [
      ...Array.from({ length: 6 }, (_, i) => ({ at: `2024-01-01T09:${String(i * 5).padStart(2, "0")}:00Z`, ...HOME })),
      { at: "2024-01-01T09:40:00Z", ...CAFE },
      { at: "2024-01-01T09:42:00Z", ...CAFE },
    ];
    const stays = staysFromPoints(pts);
    expect(stays).toHaveLength(1);
    expect(stays[0]).toMatchObject({ start: "2024-01-01T09:00:00Z", end: "2024-01-01T09:25:00Z" });
    const rec = visitsOf({ locations: pts.map((p) => ({ latitudeE7: Math.round(p.lat * 1e7), longitudeE7: Math.round(p.lon * 1e7), timestamp: p.at, accuracy: 20 })) });
    expect(rec.format).toBe("records");
    expect(rec.visits).toHaveLength(1);
  });

  it("the iPhone app's visits, in Danish", () => {
    const visits = Array.from({ length: 6 }, (_, i) => ({ arrival: `${day(i + 1)}T08:00:00Z`, departure: `${day(i + 1)}T16:00:00Z`, ...CAFE, accuracyM: 30 }));
    const plan = placesImporter.read({ filename: "places.json", bytes: Buffer.from(JSON.stringify({ visits })) }, ctx([], "da")) as ImportPlan;
    expect(labels(plan, "place")).toEqual(["Et sted du var 6 gange"]);
    expect(plan.title).toBe("Steder: 6 besøg, 1.–6. marts 2023");
  });

  it("an empty history says so", () => {
    const plan = placesImporter.read({ filename: "Timeline.json", bytes: Buffer.from('{"semanticSegments":[]}') }, ctx()) as ImportPlan;
    expect(plan.changes).toEqual([]);
    expect(plan.warnings).toContain("No visits were found in this location history.");
  });
});
