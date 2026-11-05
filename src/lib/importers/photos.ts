/**
 * Importer `photos`: the iPhone app's photo metadata (PhotoKit: when, where, albums; the image itself, when sent, is
 * a separate library upload named by `sourceId`). Pure.
 *
 * It keeps proposals few and good:
 *   - albums named like a trip or an occasion ("Rome 2024", "Sommerferie", "Skagen weekend") → one event each, with
 *     the album's first and last photo as its dates;
 *   - trips: two or more days in a row with photos far (50+ km) from everywhere the person usually takes photos;
 *   - a day out: 12+ photos at one spot away from the usual places, when the phone or the graph knows its name
 *     ("Day at Tivoli"), or 25+ photos when it doesn't;
 *   - each event is linked to a known place nearby (300 m) and to a few of its photos (the uploads);
 *   - an uploaded photo taken within 150 m of a known place is linked to it.
 * The usual places are found from the photos (where they are taken on many different days) and are never labelled:
 * nothing here decides where someone lives.
 */
import { photosPayload, type PhotosPayload } from "./schemas";
import { matchByLabel, matchPerson, normName, edgeKey } from "./match";
import { centroid, clusterPoints, coordsOf, dayOf, daysBetween, distanceM, fmtCoords, fmtDay, fmtRange, majority, nearestPlace, round5, type LatLon } from "./geo";
import type { ChangeInput } from "@/lib/changes";
import type { TextSegment } from "@/lib/ingest/chunk";
import type { ImportContext, ImportKnown, ImportPlan, Importer } from "./types";

type Photo = PhotosPayload["photos"][number] & { day: string | null; at: LatLon | null };

/** Tuning (exported for the tests). */
export const PHOTO_RULES = {
  /** Photos on this many distinct days at one spot make it a usual place (not an outing). */
  usualDays: 6,
  usualRadiusM: 1500,
  /** A day out: this far from the usual places, with this many photos at one spot. */
  awayM: 3000,
  dayOutPhotos: 12,
  dayOutUnnamedPhotos: 25,
  /** A trip: this far from the usual places on at least this many days in a row. */
  tripM: 50_000,
  tripDays: 2,
  albumMinPhotos: 4,
  albumMaxDays: 60,
  /** Photos linked to one event (favourites first), and photos linked to places in all. */
  photosPerEvent: 8,
  placeLinks: 40,
  maxEvents: 30,
};

const SYSTEM_ALBUMS = new Set([
  "recents", "recent", "favorites", "favourites", "screenshots", "selfies", "live photos", "portrait", "panoramas", "videos",
  "slo mo", "time lapse", "bursts", "hidden", "recently deleted", "recently saved", "imports", "duplicates", "raw", "animated",
  "long exposure", "spatial", "cinematic", "all photos", "camera roll", "my photo stream", "shared", "whatsapp", "instagram",
  "seneste", "favoritter", "skærmbilleder", "portræt", "panoramaer", "skjult", "skjulte", "slettet for nylig", "alle fotos",
  "kamerarulle", "gemt for nylig", "importeret", "dubletter",
]);

const OCCASION = /\b(19\d\d|20\d\d)\b|\b(trip|tour|travel|holiday|holidays|vacation|weekend|getaway|honeymoon|wedding|christmas|easter|summer|winter|camp|camping|ferie|sommerferie|vinterferie|efterårsferie|påskeferie|juleferie|rejse|tur|udflugt|bryllup|jul|påske|sommer|vinter|lejr|konfirmation|barnedåb|fødselsdag|birthday)\b/i;

/** Is this album name one a person gave to a trip or an occasion (not "Recents", not "Screenshots")? */
export function isOccasionAlbum(name: string): boolean {
  const n = name.trim();
  if (!n || n.length > 120 || SYSTEM_ALBUMS.has(normName(n))) return false;
  return OCCASION.test(n);
}

const T = {
  en: {
    title: (n: number) => `Photos: ${n} from the iPhone`,
    dayOut: (place: string) => `Day at ${place}`,
    dayOutUnnamed: (day: string) => `Day out, ${day}`,
    trip: (place: string) => `Trip to ${place}`,
    tripUnnamed: (range: string) => `Trip, ${range}`,
    photos: (n: number) => `${n} photo${n === 1 ? "" : "s"}`,
    near: "near",
    album: "Album",
    usual: "Usual places (where photos are taken on many days; not named here)",
    days: "Days with photos",
    summary: (n: number, range: string) => `${n} photos, ${range}.`,
  },
  da: {
    title: (n: number) => `Fotos: ${n} fra iPhone`,
    dayOut: (place: string) => `Dag i ${place}`,
    dayOutUnnamed: (day: string) => `Udflugt, ${day}`,
    trip: (place: string) => `Tur til ${place}`,
    tripUnnamed: (range: string) => `Tur, ${range}`,
    photos: (n: number) => `${n} ${n === 1 ? "foto" : "fotos"}`,
    near: "ved",
    album: "Album",
    usual: "Faste steder (hvor der tages fotos på mange dage; ikke navngivet her)",
    days: "Dage med fotos",
    summary: (n: number, range: string) => `${n} fotos, ${range}.`,
  },
};

type Line = { key: string; text: string };

/** Lines packed into segments of about a thousand characters; returns where each line landed. */
export function packLines(lines: Line[], max = 1000): { segments: TextSegment[]; where: Map<string, { region: string; quote: string }> } {
  const segments: TextSegment[] = [];
  const where = new Map<string, { region: string; quote: string }>();
  let buf: Line[] = [];
  const flush = () => {
    if (!buf.length) return;
    const region = buf[0].key.split(":")[0];
    segments.push({ text: buf.map((l) => l.text).join("\n"), at: { region } });
    for (const l of buf) where.set(l.key, { region, quote: l.text.slice(0, 300) });
    buf = [];
  };
  for (const l of lines) {
    if (buf.length && (buf.reduce((n, x) => n + x.text.length + 1, 0) + l.text.length > max || buf[0].key.split(":")[0] !== l.key.split(":")[0])) flush();
    buf.push(l);
  }
  flush();
  return { segments, where };
}

/** Known documents by the library source they stand for (the uploaded photos). */
function docsBySource(known: ImportKnown[]): Map<string, ImportKnown> {
  const m = new Map<string, ImportKnown>();
  for (const k of known) if (k.type === "document" && typeof k.props.sourceId === "string") m.set(k.props.sourceId, k);
  return m;
}

/** A known event this one would duplicate: same name, or a trip over the same days. */
export function knownEventFor(known: ImportKnown[], label: string, from: string, to: string): ImportKnown | null {
  const byName = matchByLabel(known, "event", label);
  if (byName) return byName;
  for (const k of known) {
    if (k.type !== "event" || !k.startAt) continue;
    const d = k.startAt.slice(0, 10);
    const end = typeof k.props.endAt === "string" ? k.props.endAt.slice(0, 10) : d;
    const overlaps = d <= to && end >= from;
    if (overlaps && (k.kind === "trip" || (from !== to && daysBetween(d, end) >= 1))) return k;
  }
  return null;
}

type Planned = {
  key: string; label: string; from: string; to: string; kind: "trip" | null; where: LatLon | null; placeName: string | null;
  photos: Photo[]; why: string;
};

export function readPhotos(data: PhotosPayload, ctx: ImportContext): ImportPlan {
  const L = T[ctx.locale];
  const R = PHOTO_RULES;
  const photos: Photo[] = data.photos.map((p) => ({
    ...p, day: p.takenAt ? dayOf(p.takenAt) : null, at: p.lat != null && p.lon != null && !(p.lat === 0 && p.lon === 0) ? { lat: p.lat, lon: p.lon } : null,
  }));
  const dated = photos.filter((p) => p.day).sort((a, b) => (a.takenAt! < b.takenAt! ? -1 : 1));
  const located = dated.filter((p) => p.at);
  const changes: ChangeInput[] = [];
  const counts: Record<string, number> = { photos: photos.length, days: 0, events: 0, trips: 0, placeLinks: 0, photoLinks: 0 };
  const lines: Line[] = [];
  const edges = new Set(ctx.existingEdges);
  const docs = docsBySource(ctx.known);

  // 1. Usual places: spots with photos on many different days (and known homes), never named here.
  const spots = clusterPoints(located.map((p) => p.at!), R.usualRadiusM);
  const usual: LatLon[] = spots.filter((s) => new Set(s.members.map((i) => located[i].day)).size >= R.usualDays).map((s) => s.center);
  for (const k of ctx.known) if (k.type === "place" && (k.kind === "home" || k.kind === "family_home")) { const c = coordsOf(k); if (c) usual.push(c); }
  const fromUsual = (p: LatLon) => (usual.length ? Math.min(...usual.map((u) => distanceM(u, p))) : Infinity);

  // 2. Days: where the photos of each day were mostly taken.
  const byDay = new Map<string, Photo[]>();
  for (const p of dated) byDay.set(p.day!, [...(byDay.get(p.day!) ?? []), p]);
  counts.days = byDay.size;
  type Day = { day: string; photos: Photo[]; main: { center: LatLon; photos: Photo[] } | null; far: number };
  const days: Day[] = [...byDay.entries()].map(([day, ps]) => {
    const loc = ps.filter((p) => p.at);
    if (!loc.length) return { day, photos: ps, main: null, far: 0 };
    const cl = clusterPoints(loc.map((p) => p.at!), 1000).sort((a, b) => b.members.length - a.members.length)[0];
    const main = { center: cl.center, photos: cl.members.map((i) => loc[i]) };
    return { day, photos: ps, main, far: fromUsual(main.center) };
  });

  const planned: Planned[] = [];
  const nameAt = (ps: Photo[], at: LatLon | null): string | null => {
    const known = at ? nearestPlace(ctx.known, at, 300) : null;
    return known?.place.label ?? majority(ps.map((p) => p.placeName), 0.5);
  };
  const covered = new Set<string>();

  // 3. Albums named like a trip or an occasion.
  const albums = new Map<string, Photo[]>();
  for (const p of dated) for (const a of p.albums) if (isOccasionAlbum(a)) albums.set(a.trim(), [...(albums.get(a.trim()) ?? []), p]);
  for (const [name, ps] of albums) {
    const from = ps[0].day!, to = ps[ps.length - 1].day!;
    if (ps.length < R.albumMinPhotos || daysBetween(from, to) > R.albumMaxDays) continue;
    const loc = ps.filter((p) => p.at);
    const where = loc.length ? centroid(loc.map((p) => p.at!)) : null;
    planned.push({ key: `album:${name}`, label: name, from, to, kind: from !== to && where && fromUsual(where) >= R.tripM ? "trip" : null, where, placeName: nameAt(loc, where), photos: ps, why: `${L.album} “${name}”` });
    for (const p of ps) covered.add(p.day!);
  }

  // 4. Trips: days in a row far from the usual places (only when there are usual places to be far from).
  if (usual.length) {
    let run: Day[] = [];
    const endRun = () => {
      if (run.length >= R.tripDays && !run.every((d) => covered.has(d.day))) {
        const ps = run.flatMap((d) => d.photos);
        const loc = run.flatMap((d) => d.main?.photos ?? []);
        const where = centroid(loc.map((p) => p.at!));
        const name = nameAt(loc, null) ?? majority(ps.map((p) => p.placeName), 0.3);
        const from = run[0].day, to = run[run.length - 1].day;
        planned.push({ key: `trip:${from}`, label: name ? L.trip(name) : L.tripUnnamed(fmtRange(from, to, ctx.locale)), from, to, kind: "trip", where, placeName: name, photos: ps, why: fmtRange(from, to, ctx.locale) });
        for (const d of run) covered.add(d.day);
      }
      run = [];
    };
    for (const d of days) {
      const far = d.main && d.far >= R.tripM;
      // A day without location (or without photos) in between doesn't end a trip.
      if (far && run.length && daysBetween(run[run.length - 1].day, d.day) > 2) endRun();
      if (far) run.push(d);
      else if (d.main) endRun();
    }
    endRun();
  }

  // 5. A day out: many photos at one spot away from the usual places.
  if (usual.length) {
    for (const d of days) {
      if (covered.has(d.day) || !d.main || d.far < R.awayM) continue;
      const name = nameAt(d.main.photos, d.main.center);
      const n = d.main.photos.length;
      if (n < (name ? R.dayOutPhotos : R.dayOutUnnamedPhotos)) continue;
      planned.push({ key: `day:${d.day}`, label: name ? L.dayOut(name) : L.dayOutUnnamed(fmtDay(d.day, ctx.locale)), from: d.day, to: d.day, kind: null, where: d.main.center, placeName: name, photos: d.main.photos, why: fmtDay(d.day, ctx.locale) });
      covered.add(d.day);
    }
  }

  // Searchable text: a line per event found, per day with photos, and the usual spots (no names, just how often).
  const first = dated[0]?.day, last = dated[dated.length - 1]?.day;
  lines.push({ key: "summary:0", text: L.summary(photos.length, first && last ? fmtRange(first, last, ctx.locale) : "–") });
  const lineFor = (p: Planned) => `${p.label} — ${fmtRange(p.from, p.to, ctx.locale)} — ${L.photos(p.photos.length)}${p.where ? ` ${L.near} ${p.placeName ? `${p.placeName} ` : ""}(${fmtCoords(p.where)})` : ""}`;
  planned.sort((a, b) => b.photos.length - a.photos.length);
  const kept = planned.slice(0, R.maxEvents).sort((a, b) => (a.from < b.from ? -1 : 1));
  for (const p of kept) lines.push({ key: `events:${p.key}`, text: lineFor(p) });
  for (const d of days) {
    const names = [...new Set(d.photos.map((p) => p.placeName).filter(Boolean))].slice(0, 5).join(", ");
    lines.push({ key: `days:${d.day}`, text: `${d.day}: ${L.photos(d.photos.length)}${names ? ` — ${names}` : ""}` });
  }
  const { segments, where } = packLines(lines);
  const receipt = (key: string, confidence = 0.8) => {
    const w = where.get(key);
    return { sourceId: ctx.sourceId, quote: w?.quote, locator: w ? { region: w.region } : undefined, confidence };
  };

  // 6. Proposals.
  for (const p of kept) {
    if (knownEventFor(ctx.known, p.label, p.from, p.to)) continue;
    const id = ctx.mint();
    const r = receipt(`events:${p.key}`);
    changes.push({
      op: "addNode", nodeId: id, type: "event", kind: p.kind, label: p.label.slice(0, 200), visibility: ctx.visibility,
      summary: `${p.why}: ${L.photos(p.photos.length)}.`,
      startAt: `${p.from}T00:00:00.000Z`, endAt: p.to !== p.from ? `${p.to}T23:59:59.000Z` : null,
      props: { allDay: true, photos: p.photos.length, ...(p.where ? { lat: round5(p.where.lat), lon: round5(p.where.lon) } : {}), from: "photos" },
      receipt: r,
    });
    counts.events++;
    if (p.kind === "trip") counts.trips++;
    const place = p.where ? nearestPlace(ctx.known, p.where, 300)?.place ?? null : null;
    const byName = !place && p.placeName ? matchByLabel(ctx.known, "place", p.placeName) : null;
    const at = place ?? byName;
    if (at) changes.push({ op: "addEdge", edgeId: ctx.mint(), fromId: id, toId: at.id, relation: "happened_at", confidence: place ? 0.85 : 0.7, receipt: r });
    // A few of its photos (the uploaded ones), favourites first.
    const withDoc = p.photos.filter((x) => x.sourceId && docs.has(x.sourceId)).sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite)).slice(0, R.photosPerEvent);
    for (const x of withDoc) {
      changes.push({ op: "addEdge", edgeId: ctx.mint(), fromId: docs.get(x.sourceId!)!.id, toId: id, relation: "about", confidence: 0.8, receipt: r });
      counts.photoLinks++;
    }
  }

  // 7. Uploaded photos taken at a known place.
  for (const p of located) {
    if (counts.placeLinks >= R.placeLinks) break;
    const doc = p.sourceId ? docs.get(p.sourceId) : null;
    if (!doc) continue;
    const near = nearestPlace(ctx.known, p.at!, 150);
    if (!near || edges.has(edgeKey(doc.id, "located_at", near.place.id))) continue;
    edges.add(edgeKey(doc.id, "located_at", near.place.id));
    changes.push({
      op: "addEdge", edgeId: ctx.mint(), fromId: doc.id, toId: near.place.id, relation: "located_at", confidence: 0.9,
      receipt: { ...receipt(`days:${p.day}`, 0.9) },
      note: `Taken ${Math.round(near.distanceM)} m from ${near.place.label}.`,
    });
    counts.placeLinks++;
  }

  // 8. An album named exactly like one person in the graph: its uploaded photos are about them.
  for (const [name, ps] of new Map([...new Set(dated.flatMap((p) => p.albums))].map((a) => [a, dated.filter((p) => p.albums.includes(a))]))) {
    if (isOccasionAlbum(name) || SYSTEM_ALBUMS.has(normName(name))) continue;
    const person = matchPerson(ctx.known, { name });
    if (!person) continue;
    for (const x of ps.filter((q) => q.sourceId && docs.has(q.sourceId)).slice(0, R.photosPerEvent)) {
      const doc = docs.get(x.sourceId!)!;
      if (edges.has(edgeKey(doc.id, "about", person.id))) continue;
      edges.add(edgeKey(doc.id, "about", person.id));
      changes.push({ op: "addEdge", edgeId: ctx.mint(), fromId: doc.id, toId: person.id, relation: "about", confidence: 0.75, receipt: receipt(`days:${x.day}`, 0.75), note: `In the album “${name}”.` });
      counts.photoLinks++;
    }
  }

  return {
    segments, changes, counts, title: L.title(photos.length), extract: false,
    occurredAt: last ? new Date(dated[dated.length - 1].takenAt!) : null,
  };
}

export const photosImporter: Importer = {
  id: "photos",
  label: "Photos (iPhone)",
  mime: "application/json",
  json: photosPayload,
  sensitive: true,
  // Only the app's own batch, saved as a file: {"photos":[{"id":…
  detect: ({ filename, head }) => /\.json$/i.test(filename) && /^\s*\{\s*"photos"\s*:\s*\[\s*(\]|\{\s*"id")/.test(new TextDecoder().decode(head.subarray(0, 200))),
  read(input, ctx) {
    const data = photosPayload.parse(JSON.parse(input.bytes.toString("utf8")));
    return readPhotos(data, ctx);
  },
};
