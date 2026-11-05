/**
 * Importer `places`: where a person has been. Pure. Reads
 *   - the iPhone app's visits (CLVisit, `placesPayload`, POST /api/import/places),
 *   - Google Takeout's location history: the monthly "Semantic Location History/2023/2023_MARCH.json" files
 *     (timelineObjects with placeVisit: name, address, placeId) and/or "Records.json" (raw points, turned into stays),
 *   - Google Maps' newer on-device Timeline export: "Timeline.json" (Android, semanticSegments) and
 *     "location-history.json" (iPhone, a list of visits with "geo:" places).
 *
 * Visits are gathered into places (by Google's place id, else within 100 m). It proposes:
 *   - coordinates for places the graph already knows (matched within 150 m, or by name nearby) when they have none,
 *   - new places that matter (named and visited on 2+ days, or unnamed but visited on 5+ days); an unnamed one is
 *     "A place you were 46 times" with its coordinates, for the person to name. Nothing is ever labelled home or work
 *     automatically, even when Google calls it that: the note says so and the person decides,
 *   - trips: two or more days in a row 50+ km from every place the person is often at, as events.
 * Coordinates never leave the graph: no reverse geocoding; names and towns come from what the export carries.
 */
import { placesPayload } from "./schemas";
import { edgeKey, matchByLabel } from "./match";
import { centroid, clusterPoints, coordsOf, dayOf, daysBetween, distanceM, fmtCoords, fmtRange, majority, nearestPlace, round5, townOf, validLatLon, type LatLon } from "./geo";
import { knownEventFor, packLines } from "./photos";
import type { ChangeInput } from "@/lib/changes";
import type { ImportContext, ImportInput, ImportPlan, Importer } from "./types";

export type Visit = {
  start: string;
  end: string | null;
  lat: number;
  lon: number;
  name: string | null;
  address: string | null;
  placeId: string | null;
  /** What the source calls the place (Google: home / work). Shown in a note, never used to label. */
  hint: "home" | "work" | null;
};

export const PLACE_RULES = {
  sameSpotM: 100,
  /** Matching a known place by coordinates, and how far a match by name may be. */
  matchM: 150,
  nameMatchM: 2000,
  /** Usual places: visited on this many distinct days. */
  usualDays: 5,
  namedMinDays: 2,
  namedMinVisits: 3,
  unnamedMinDays: 5,
  maxNewPlaces: 40,
  tripM: 50_000,
  tripDays: 2,
  maxTrips: 30,
  /** Raw points: a stay is this long within this distance. */
  stayMinutes: 15,
  stayM: 120,
};

/* ── Reading the formats ─────────────────────────────────────────────────────────────────────────────── */

const isoOf = (v: unknown): string | null => {
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return v;
  if ((typeof v === "string" && /^\d{12,14}$/.test(v)) || typeof v === "number") {
    const d = new Date(Number(v));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
};
const e7 = (v: unknown) => (typeof v === "number" ? v / 1e7 : NaN);
const str = (v: unknown, max = 300) => (typeof v === "string" && v.trim() ? v.replace(/\s+/g, " ").trim().slice(0, max) : null);

function hintOf(semanticType: unknown): Visit["hint"] {
  const s = typeof semanticType === "string" ? semanticType.toUpperCase() : "";
  if (/HOME/.test(s)) return "home";
  if (/WORK/.test(s)) return "work";
  return null;
}

/** "55.6761°, 12.5683°", "geo:55.676100,12.568300" or {latLng: …} → coordinates. */
export function parseLatLng(v: unknown): LatLon | null {
  const s = typeof v === "string" ? v : v && typeof v === "object" && typeof (v as { latLng?: unknown }).latLng === "string" ? (v as { latLng: string }).latLng : null;
  if (!s) return null;
  const m = s.replace(/^geo:/, "").match(/(-?\d+(?:\.\d+)?)°?\s*,\s*(-?\d+(?:\.\d+)?)°?/);
  if (!m) return null;
  const lat = Number(m[1]), lon = Number(m[2]);
  return validLatLon(lat, lon) ? { lat, lon } : null;
}

type O = Record<string, unknown>;
const obj = (v: unknown): O | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as O) : null);

/** Takeout's monthly Semantic Location History. */
function fromTimelineObjects(list: unknown[]): Visit[] {
  const out: Visit[] = [];
  const add = (pv: O | null) => {
    const loc = obj(pv?.location);
    const dur = obj(pv?.duration);
    if (!loc || !dur) return;
    const lat = e7(loc.latitudeE7), lon = e7(loc.longitudeE7);
    const start = isoOf(dur.startTimestamp ?? dur.startTimestampMs);
    if (!start || !validLatLon(lat, lon)) return;
    out.push({
      start, end: isoOf(dur.endTimestamp ?? dur.endTimestampMs), lat, lon, name: str(loc.name), address: str(loc.address, 400),
      placeId: str(loc.placeId, 200), hint: hintOf(loc.semanticType),
    });
    for (const c of Array.isArray(pv?.childVisits) ? pv!.childVisits as unknown[] : []) add(obj(c));
  };
  for (const t of list) add(obj(obj(t)?.placeVisit));
  return out;
}

/** The on-device Timeline export (Android "Timeline.json" segments, or the iPhone's list). */
function fromSegments(list: unknown[]): Visit[] {
  const out: Visit[] = [];
  for (const s of list) {
    const seg = obj(s);
    const visit = obj(seg?.visit);
    const top = obj(visit?.topCandidate);
    if (!seg || !top) continue;
    const at = parseLatLng(top.placeLocation);
    const start = isoOf(seg.startTime);
    if (!at || !start) continue;
    out.push({ start, end: isoOf(seg.endTime), lat: at.lat, lon: at.lon, name: null, address: null, placeId: str(top.placeId ?? top.placeID, 200), hint: hintOf(top.semanticType) });
  }
  return out;
}

/** Raw points (Records.json) → stays of 15+ minutes within ~120 m. */
export function staysFromPoints(points: { at: string; lat: number; lon: number }[]): Visit[] {
  const pts = points.filter((p) => validLatLon(p.lat, p.lon)).sort((a, b) => (a.at < b.at ? -1 : 1));
  const out: Visit[] = [];
  let i = 0;
  while (i < pts.length) {
    let j = i + 1;
    const group = [pts[i]];
    while (j < pts.length) {
      const c = centroid(group);
      if (distanceM(c, pts[j]) > PLACE_RULES.stayM) break;
      group.push(pts[j]);
      j++;
    }
    const minutes = (Date.parse(group[group.length - 1].at) - Date.parse(group[0].at)) / 60_000;
    if (minutes >= PLACE_RULES.stayMinutes) {
      const c = centroid(group);
      out.push({ start: group[0].at, end: group[group.length - 1].at, lat: c.lat, lon: c.lon, name: null, address: null, placeId: null, hint: null });
    }
    i = j;
  }
  return out;
}

function fromRecords(list: unknown[]): Visit[] {
  const pts: { at: string; lat: number; lon: number }[] = [];
  for (const r of list) {
    const o = obj(r);
    if (!o) continue;
    const at = isoOf(o.timestamp ?? o.timestampMs);
    const lat = e7(o.latitudeE7), lon = e7(o.longitudeE7);
    if (at && validLatLon(lat, lon) && !(typeof o.accuracy === "number" && o.accuracy > 500)) pts.push({ at, lat, lon });
  }
  return staysFromPoints(pts);
}

/** Every visit one parsed JSON document holds (whichever of the formats it is). */
export function visitsOf(doc: unknown): { visits: Visit[]; format: string | null; frequent: { at: LatLon; hint: Visit["hint"] }[] } {
  const o = obj(doc);
  if (o && Array.isArray(o.timelineObjects)) return { visits: fromTimelineObjects(o.timelineObjects), format: "semantic", frequent: [] };
  if (o && Array.isArray(o.semanticSegments)) {
    const fp = obj(o.userLocationProfile)?.frequentPlaces;
    const frequent = (Array.isArray(fp) ? fp : []).flatMap((f) => {
      const at = parseLatLng(obj(f)?.placeLocation);
      return at ? [{ at, hint: hintOf(obj(f)?.label) }] : [];
    });
    return { visits: fromSegments(o.semanticSegments), format: "timeline", frequent };
  }
  if (o && Array.isArray(o.locations)) return { visits: fromRecords(o.locations), format: "records", frequent: [] };
  if (o && Array.isArray(o.visits)) {
    const p = placesPayload.safeParse(o);
    if (!p.success) return { visits: [], format: null, frequent: [] };
    return {
      visits: p.data.visits.filter((v) => (v.accuracyM ?? 0) <= 1000).map((v) => ({ start: v.arrival, end: v.departure ?? null, lat: v.lat, lon: v.lon, name: v.placeName?.trim() || null, address: null, placeId: null, hint: null })),
      format: "iphone", frequent: [],
    };
  }
  if (Array.isArray(doc)) return { visits: fromSegments(doc), format: "timeline", frequent: [] };
  return { visits: [], format: null, frequent: [] };
}

/* ── Detecting ───────────────────────────────────────────────────────────────────────────────────────── */

const MONTH_FILE = /(^|\/)\d{4}\/\d{4}_(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)\.json$/;
const LOCATION_DIR = /(Location History|Semantic Location History|Placeringshistorik|Tidslinje|Timeline)/i;

/** A zip entry the importer reads. */
export function isLocationEntry(name: string): boolean {
  if (/(^|\/)(__MACOSX|\.)/.test(name)) return false;
  if (MONTH_FILE.test(name) && LOCATION_DIR.test(name)) return true;
  if (/(^|\/)Records\.json$/.test(name) && LOCATION_DIR.test(name)) return true;
  return /(^|\/)(Timeline|location-history|Tidslinje)\.json$/i.test(name);
}

/** The first bytes of a JSON file in one of the formats (certain, no false positives on other JSON). */
export function looksLikeLocationJson(head: string): boolean {
  const h = head.slice(0, 4000);
  if (/^\s*\{\s*"timelineObjects"\s*:\s*\[/.test(h)) return true;
  if (/^\s*\{\s*"semanticSegments"\s*:\s*\[/.test(h)) return true;
  if (/^\s*\{\s*"locations"\s*:\s*\[\s*\{[^}]*"latitudeE7"/.test(h)) return true;
  if (/^\s*\{\s*"visits"\s*:\s*\[\s*(\]|\{\s*"arrival")/.test(h)) return true;
  return /^\s*\[\s*\{\s*"(endTime|startTime)"/.test(h) && /"(topCandidate|timelinePath|activity)"/.test(h) && /"placeLocation"\s*:\s*"geo:|"timelinePath"|"activity"/.test(h);
}

/* ── Planning ────────────────────────────────────────────────────────────────────────────────────────── */

const T = {
  en: {
    title: (n: number, range: string) => `Places: ${n} visits, ${range}`,
    unnamed: (n: number) => `A place you were ${n} times`,
    trip: (town: string) => `Trip to ${town}`,
    tripUnnamed: (range: string) => `Trip, ${range}`,
    visits: (n: number, d: number) => `${n} visit${n === 1 ? "" : "s"} on ${d} day${d === 1 ? "" : "s"}`,
    hint: (h: string) => `The location history calls this place “${h}”. Name it yourself if that is right; My Graph never decides that on its own.`,
    nameIt: "Give it a name you recognise before you deliver it.",
    summary: (n: number, p: number, range: string) => `${n} visits to ${p} places, ${range}.`,
    tripLine: (range: string, days: number) => `${range} (${days} days), far from the usual places`,
    month: "Month",
  },
  da: {
    title: (n: number, range: string) => `Steder: ${n} besøg, ${range}`,
    unnamed: (n: number) => `Et sted du var ${n} gange`,
    trip: (town: string) => `Tur til ${town}`,
    tripUnnamed: (range: string) => `Tur, ${range}`,
    visits: (n: number, d: number) => `${n} besøg på ${d} ${d === 1 ? "dag" : "dage"}`,
    hint: (h: string) => `Placeringshistorikken kalder stedet “${h}”. Navngiv det selv, hvis det passer; My Graph bestemmer det aldrig selv.`,
    nameIt: "Giv det et navn, du kender, før du leverer det.",
    summary: (n: number, p: number, range: string) => `${n} besøg på ${p} steder, ${range}.`,
    tripLine: (range: string, days: number) => `${range} (${days} dage), langt fra de faste steder`,
    month: "Måned",
  },
};

type Spot = {
  key: string; at: LatLon; visits: Visit[]; days: Set<string>; minutes: number; name: string | null; address: string | null;
  placeId: string | null; hint: Visit["hint"]; first: string; last: string;
};

/** Visits gathered into places: by Google's place id, else within 100 m. */
export function gatherSpots(visits: Visit[]): Spot[] {
  const groups: Visit[][] = [];
  const byId = new Map<string, Visit[]>();
  const loose: Visit[] = [];
  for (const v of visits) {
    if (v.placeId) byId.set(v.placeId, [...(byId.get(v.placeId) ?? []), v]);
    else loose.push(v);
  }
  groups.push(...byId.values());
  for (const c of clusterPoints(loose.map((v) => ({ lat: v.lat, lon: v.lon })), PLACE_RULES.sameSpotM)) groups.push(c.members.map((i) => loose[i]));
  return groups.map((vs, i) => {
    vs.sort((a, b) => (a.start < b.start ? -1 : 1));
    const days = new Set(vs.map((v) => dayOf(v.start)));
    const minutes = vs.reduce((n, v) => n + (v.end ? Math.max(0, Math.min(24 * 60, (Date.parse(v.end) - Date.parse(v.start)) / 60_000)) : 0), 0);
    const hints = vs.map((v) => v.hint).filter(Boolean) as string[];
    return {
      key: `p${i}`, at: centroid(vs.map((v) => ({ lat: v.lat, lon: v.lon }))), visits: vs, days, minutes,
      name: majority(vs.map((v) => v.name), 0.3), address: majority(vs.map((v) => v.address), 0.3), placeId: vs[0].placeId,
      hint: (majority(hints, 0.5) as Visit["hint"]) ?? null, first: dayOf(vs[0].start), last: dayOf(vs[vs.length - 1].start),
    };
  });
}

export function planPlaces(visits: Visit[], ctx: ImportContext, frequent: { at: LatLon; hint: Visit["hint"] }[] = [], warnings: string[] = []): ImportPlan {
  const L = T[ctx.locale];
  const R = PLACE_RULES;
  const changes: ChangeInput[] = [];
  const counts: Record<string, number> = { visits: visits.length, places: 0, matched: 0, newPlaces: 0, trips: 0 };
  const sorted = [...visits].sort((a, b) => (a.start < b.start ? -1 : 1));
  const spots = gatherSpots(sorted);
  counts.places = spots.length;
  const first = sorted[0] ? dayOf(sorted[0].start) : null, last = sorted.length ? dayOf(sorted[sorted.length - 1].start) : null;
  const range = first && last ? fmtRange(first, last, ctx.locale) : "–";

  // Hints from the export's own list of frequent places (the on-device Timeline): attach to the spot they sit on.
  for (const f of frequent) {
    if (!f.hint) continue;
    const s = spots.find((x) => distanceM(x.at, f.at) <= R.sameSpotM);
    if (s && !s.hint) s.hint = f.hint;
  }

  // Usual places: often visited (and known homes); trips are days far from all of them.
  const usual: LatLon[] = [
    ...spots.filter((s) => s.days.size >= R.usualDays || s.hint).map((s) => s.at),
    ...frequent.map((f) => f.at),
    ...ctx.known.flatMap((k) => (k.type === "place" && (k.kind === "home" || k.kind === "family_home") ? [coordsOf(k)].filter((c): c is LatLon => !!c) : [])),
  ];
  const fromUsual = (p: LatLon) => (usual.length ? Math.min(...usual.map((u) => distanceM(u, p))) : Infinity);

  // Trips.
  type Trip = { from: string; to: string; spots: Set<string>; visits: Visit[] };
  const trips: Trip[] = [];
  if (usual.length) {
    const spotOf = new Map<Visit, Spot>();
    for (const s of spots) for (const v of s.visits) spotOf.set(v, s);
    const byDay = new Map<string, Visit[]>();
    for (const v of sorted) byDay.set(dayOf(v.start), [...(byDay.get(dayOf(v.start)) ?? []), v]);
    let run: { day: string; visits: Visit[] }[] = [];
    const end = () => {
      if (run.length >= R.tripDays) {
        const vs = run.flatMap((d) => d.visits);
        trips.push({ from: run[0].day, to: run[run.length - 1].day, visits: vs, spots: new Set(vs.map((v) => spotOf.get(v)!.key)) });
      }
      run = [];
    };
    for (const [day, vs] of byDay) {
      const away = vs.every((v) => fromUsual(v) >= R.tripM);
      if (away && run.length && daysBetween(run[run.length - 1].day, day) > 2) end();
      if (away) run.push({ day, visits: vs }); else end();
    }
    end();
  }

  // Which spots to propose (or match): those that matter.
  const matters = (s: Spot) => s.name ? s.days.size >= R.namedMinDays || s.visits.length >= R.namedMinVisits : s.days.size >= R.unnamedMinDays;
  const inTrip = new Set(trips.flatMap((t) => [...t.spots]));
  const spotLine = (s: Spot) => `${s.name ?? L.unnamed(s.visits.length)}${s.address && s.address !== s.name ? `, ${s.address}` : ""} — ${fmtCoords(s.at)} — ${L.visits(s.visits.length, s.days.size)}, ${s.first} – ${s.last}`;

  // Searchable text: summary, places (most days first), trips, and the named places of each month.
  const shown = [...spots].sort((a, b) => b.days.size - a.days.size || b.visits.length - a.visits.length).filter((s) => s.name || matters(s) || inTrip.has(s.key)).slice(0, 400);
  const lines: { key: string; text: string }[] = [{ key: "summary:0", text: L.summary(visits.length, spots.length, range) }];
  for (const s of shown) lines.push({ key: `places:${s.key}`, text: spotLine(s) });
  const tripName = (t: Trip) => majority(t.visits.map((v) => townOf(v.address)), 0.3) ?? majority(t.visits.map((v) => v.name), 0.4);
  for (const [i, t] of trips.entries()) {
    const n = tripName(t);
    lines.push({ key: `trips:${i}`, text: `${n ? L.trip(n) : L.tripUnnamed(fmtRange(t.from, t.to, ctx.locale))}: ${L.tripLine(fmtRange(t.from, t.to, ctx.locale), daysBetween(t.from, t.to) + 1)}` });
  }
  const months = new Map<string, Map<string, number>>();
  for (const v of sorted) {
    if (!v.name) continue;
    const m = dayOf(v.start).slice(0, 7);
    const mm = months.get(m) ?? new Map<string, number>();
    mm.set(v.name, (mm.get(v.name) ?? 0) + 1);
    months.set(m, mm);
  }
  for (const [m, mm] of months) {
    const top = [...mm.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([n, c]) => (c > 1 ? `${n} (${c})` : n)).join(", ");
    lines.push({ key: `months:${m}`, text: `${L.month} ${m}: ${top}` });
  }
  const { segments, where } = packLines(lines);
  const receipt = (key: string, confidence: number) => {
    const w = where.get(key);
    return { sourceId: ctx.sourceId, quote: w?.quote, locator: w ? { region: w.region } : undefined, confidence };
  };

  // Places: match what the graph knows, propose what matters.
  const nodeOf = new Map<string, string>();
  const candidates = spots.filter(matters).sort((a, b) => b.days.size - a.days.size || b.visits.length - a.visits.length);
  let fresh = 0;
  for (const s of candidates) {
    const byCoords = nearestPlace(ctx.known, s.at, R.matchM)?.place ?? null;
    const byName = !byCoords && s.name ? matchByLabel(ctx.known, "place", s.name) : null;
    const nameOk = byName && (() => { const c = coordsOf(byName); return !c || distanceM(c, s.at) <= R.nameMatchM; })();
    const known = byCoords ?? (nameOk ? byName : null);
    if (known) {
      nodeOf.set(s.key, known.id);
      counts.matched++;
      if (!coordsOf(known)) {
        const set: Record<string, unknown> = { lat: round5(s.at.lat), lon: round5(s.at.lon) };
        if (s.address && typeof known.props.address !== "string") set.address = s.address;
        changes.push({ op: "updateNode", nodeId: known.id, set: { props: set }, receipt: receipt(`places:${s.key}`, 0.8), note: `Where ${known.label} is, from the location history.` });
      }
      continue;
    }
    if (fresh >= R.maxNewPlaces || (!s.name && !inTrip.has(s.key) && s.days.size < R.unnamedMinDays)) continue;
    fresh++;
    const id = ctx.mint();
    nodeOf.set(s.key, id);
    const notes = [!s.name ? L.nameIt : null, s.hint ? L.hint(s.hint === "home" ? (ctx.locale === "da" ? "Hjem" : "Home") : (ctx.locale === "da" ? "Arbejde" : "Work")) : null].filter(Boolean).join(" ");
    changes.push({
      op: "addNode", nodeId: id, type: "place", label: (s.name ?? L.unnamed(s.visits.length)).slice(0, 200), visibility: ctx.visibility,
      summary: `${L.visits(s.visits.length, s.days.size)}, ${fmtRange(s.first, s.last, ctx.locale)}.`,
      props: {
        lat: round5(s.at.lat), lon: round5(s.at.lon), ...(s.address ? { address: s.address } : {}), ...(s.placeId ? { googlePlaceId: s.placeId } : {}),
        visits: s.visits.length, daysVisited: s.days.size, hoursSpent: Math.round(s.minutes / 60), firstSeen: s.first, lastSeen: s.last,
        ...(s.name ? {} : { unnamed: true }),
      },
      receipt: receipt(`places:${s.key}`, s.name ? 0.8 : 0.6),
      ...(notes ? { note: notes } : {}),
    });
    counts.newPlaces++;
  }

  // Trips as events, linked to the place they were mostly at when that place is known or proposed.
  for (const [i, t] of trips.slice(0, R.maxTrips).entries()) {
    const n = tripName(t);
    const label = n ? L.trip(n) : L.tripUnnamed(fmtRange(t.from, t.to, ctx.locale));
    if (knownEventFor(ctx.known, label, t.from, t.to)) continue;
    const id = ctx.mint();
    const r = receipt(`trips:${i}`, 0.75);
    const c = centroid(t.visits.map((v) => ({ lat: v.lat, lon: v.lon })));
    changes.push({
      op: "addNode", nodeId: id, type: "event", kind: "trip", label: label.slice(0, 200), visibility: ctx.visibility,
      summary: L.tripLine(fmtRange(t.from, t.to, ctx.locale), daysBetween(t.from, t.to) + 1),
      startAt: `${t.from}T00:00:00.000Z`, endAt: `${t.to}T23:59:59.000Z`,
      props: { allDay: true, lat: round5(c.lat), lon: round5(c.lon), visits: t.visits.length, from: "location history" },
      receipt: r,
    });
    counts.trips++;
    const dwell = new Map<string, number>();
    const spotOfVisit = new Map<Visit, string>();
    for (const s of spots) for (const v of s.visits) spotOfVisit.set(v, s.key);
    let total = 0;
    for (const v of t.visits) {
      const m = v.end ? Math.max(1, (Date.parse(v.end) - Date.parse(v.start)) / 60_000) : 1;
      total += m;
      const k = spotOfVisit.get(v)!;
      dwell.set(k, (dwell.get(k) ?? 0) + m);
    }
    const [topKey, topMin] = [...dwell.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
    const placeId = topKey ? nodeOf.get(topKey) : undefined;
    if (placeId && topMin! / total >= 0.5 && !ctx.existingEdges.has(edgeKey(id, "happened_at", placeId))) {
      changes.push({ op: "addEdge", edgeId: ctx.mint(), fromId: id, toId: placeId, relation: "happened_at", confidence: 0.7, receipt: r });
    }
  }

  return {
    segments, changes, counts, warnings, extract: false, title: L.title(visits.length, range),
    occurredAt: sorted.length ? new Date(sorted[sorted.length - 1].start) : null,
  };
}

function readAll(input: ImportInput): { visits: Visit[]; frequent: { at: LatLon; hint: Visit["hint"] }[]; warnings: string[] } {
  const docs: { name: string; bytes: Uint8Array }[] = input.entries?.length ? input.entries.filter((e) => isLocationEntry(e.name)) : [{ name: input.filename, bytes: input.bytes }];
  const visits: Visit[] = [], frequent: { at: LatLon; hint: Visit["hint"] }[] = [], warnings: string[] = [];
  const dec = new TextDecoder();
  const hasSemantic = docs.some((d) => MONTH_FILE.test(d.name));
  for (const d of docs) {
    // Records.json is the raw trail behind the monthly files: read it only when there are no monthly files.
    if (hasSemantic && /(^|\/)Records\.json$/.test(d.name)) continue;
    let doc: unknown;
    try { doc = JSON.parse(dec.decode(d.bytes)); } catch { warnings.push(`“${d.name.split("/").pop()}” couldn't be read (it isn't valid JSON or is too large).`); continue; }
    const r = visitsOf(doc);
    visits.push(...r.visits);
    frequent.push(...r.frequent);
  }
  // The same visit in two files (an overlap between exports): keep one.
  const seen = new Set<string>();
  const unique = visits.filter((v) => {
    const k = `${v.start.slice(0, 16)}|${v.lat.toFixed(4)}|${v.lon.toFixed(4)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (!unique.length) warnings.push("No visits were found in this location history.");
  return { visits: unique, frequent, warnings };
}

export const placesImporter: Importer = {
  id: "places",
  label: "Location history",
  mime: "application/json",
  json: placesPayload,
  sensitive: true,
  detect: ({ filename, head }) => /\.json$/i.test(filename) && looksLikeLocationJson(new TextDecoder().decode(head)),
  detectArchive: ({ names }) => names.some((n) => isLocationEntry(n) && (MONTH_FILE.test(n) || /Records\.json$/.test(n) || /(Timeline|location-history)\.json$/i.test(n))),
  acceptEntry: isLocationEntry,
  read(input, ctx) {
    const { visits, frequent, warnings } = readAll(input);
    return planPlaces(visits, ctx, frequent, warnings);
  },
};
