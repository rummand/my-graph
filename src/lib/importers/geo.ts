/**
 * Small geography for the photo and place importers (pure, no network). Coordinates never leave the graph: no
 * reverse geocoding service is asked; names come from what the source already carries (the phone's place name,
 * Google's place names and addresses) or from places the graph already knows (props.lat / props.lon).
 */
import type { ImportKnown } from "./types";

export type LatLon = { lat: number; lon: number };

const R = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;

/** Distance in metres (haversine). */
export function distanceM(a: LatLon, b: LatLon): number {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

export function validLatLon(lat: number | null | undefined, lon: number | null | undefined): lat is number {
  return typeof lat === "number" && typeof lon === "number" && Number.isFinite(lat) && Number.isFinite(lon)
    && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
}

/** Where a known node is, from props.lat/lon (or latitude/longitude, lng), when it says. */
export function coordsOf(k: Pick<ImportKnown, "props">): LatLon | null {
  const p = k.props ?? {};
  const lat = num(p.lat ?? p.latitude);
  const lon = num(p.lon ?? p.lng ?? p.longitude);
  return validLatLon(lat, lon) ? { lat, lon: lon! } : null;
}

/** The nearest known place within `maxM` metres, if any. */
export function nearestPlace(known: ImportKnown[], at: LatLon, maxM = 150): { place: ImportKnown; distanceM: number } | null {
  let best: { place: ImportKnown; distanceM: number } | null = null;
  for (const k of known) {
    if (k.type !== "place") continue;
    const c = coordsOf(k);
    if (!c) continue;
    const d = distanceM(c, at);
    if (d <= maxM && (!best || d < best.distanceM)) best = { place: k, distanceM: d };
  }
  return best;
}

/** "55.67610, 12.56830" (about a metre). */
export const fmtCoords = (p: LatLon) => `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;

export const round5 = (n: number) => Math.round(n * 1e5) / 1e5;

/** Mean of points (fine at the scale of a place or a city). */
export function centroid(points: LatLon[]): LatLon {
  let lat = 0, lon = 0;
  for (const p of points) { lat += p.lat; lon += p.lon; }
  return { lat: lat / points.length, lon: lon / points.length };
}

/**
 * Greedy clustering: each point joins the nearest cluster whose centre is within `radiusM`, else starts one; centres
 * follow their members. A grid keeps it fast on tens of thousands of points. Returns, per cluster, its member indexes.
 */
export function clusterPoints(points: LatLon[], radiusM: number): { center: LatLon; members: number[] }[] {
  const cell = radiusM / 111_320; // degrees of latitude per cell
  const grid = new Map<string, number[]>();
  const clusters: { center: LatLon; sum: LatLon; members: number[] }[] = [];
  const keyOf = (p: LatLon) => [Math.floor(p.lat / cell), Math.floor(p.lon / cell)] as const;
  points.forEach((p, i) => {
    const [cy, cx] = keyOf(p);
    const span = Math.min(60, Math.ceil(1 / Math.max(0.05, Math.cos(rad(p.lat)))));
    let best = -1, bestD = Infinity;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -span; dx <= span; dx++) {
        for (const ci of grid.get(`${cy + dy}:${cx + dx}`) ?? []) {
          const d = distanceM(clusters[ci].center, p);
          if (d <= radiusM && d < bestD) { best = ci; bestD = d; }
        }
      }
    }
    if (best < 0) {
      clusters.push({ center: { ...p }, sum: { ...p }, members: [i] });
      const k = `${cy}:${cx}`;
      grid.set(k, [...(grid.get(k) ?? []), clusters.length - 1]);
      return;
    }
    const c = clusters[best];
    c.members.push(i);
    c.sum = { lat: c.sum.lat + p.lat, lon: c.sum.lon + p.lon };
    // The centre moves, but stays filed under the cell it started in (a cluster is far smaller than a cell's reach).
    c.center = { lat: c.sum.lat / c.members.length, lon: c.sum.lon / c.members.length };
  });
  return clusters.map(({ center, members }) => ({ center, members }));
}

/** The local calendar day of an ISO time as written ("2024-05-12T09:30:00+02:00" → "2024-05-12"). */
export function dayOf(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : new Date(iso).toISOString().slice(0, 10);
}

/** Whole days from day a to day b ("YYYY-MM-DD"). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

const MONTHS = {
  en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  da: ["januar", "februar", "marts", "april", "maj", "juni", "juli", "august", "september", "oktober", "november", "december"],
};

/** "12 May 2024" / "12. maj 2024". */
export function fmtDay(day: string, locale: "en" | "da"): string {
  const [y, m, d] = day.split("-").map(Number);
  return locale === "da" ? `${d}. ${MONTHS.da[m - 1]} ${y}` : `${d} ${MONTHS.en[m - 1]} ${y}`;
}

/** "3–7 May 2024", "28 April – 2 May 2024" (Danish: "3.–7. maj 2024"). */
export function fmtRange(a: string, b: string, locale: "en" | "da"): string {
  if (a === b) return fmtDay(a, locale);
  const [ya, ma, da] = a.split("-").map(Number);
  const [yb, mb, db] = b.split("-").map(Number);
  const M = MONTHS[locale];
  if (locale === "da") {
    if (ya === yb && ma === mb) return `${da}.–${db}. ${M[mb - 1]} ${yb}`;
    if (ya === yb) return `${da}. ${M[ma - 1]} – ${db}. ${M[mb - 1]} ${yb}`;
    return `${fmtDay(a, locale)} – ${fmtDay(b, locale)}`;
  }
  if (ya === yb && ma === mb) return `${da}–${db} ${M[mb - 1]} ${yb}`;
  if (ya === yb) return `${da} ${M[ma - 1]} – ${db} ${M[mb - 1]} ${yb}`;
  return `${fmtDay(a, locale)} – ${fmtDay(b, locale)}`;
}

/** The most common non-empty value, if it covers at least `share` of the votes. */
export function majority(values: (string | null | undefined)[], share = 0.4): string | null {
  const counts = new Map<string, number>();
  let total = 0;
  for (const v of values) {
    total++;
    const s = v?.replace(/\s+/g, " ").trim();
    if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  let best: string | null = null, n = 0;
  for (const [k, c] of counts) if (c > n) { best = k; n = c; }
  return best && n / Math.max(1, total) >= share ? best : null;
}

/**
 * The town in a postal address as Google writes it ("Via del Corso 12, 00186 Roma RM, Italy" → "Roma",
 * "Vesterbrogade 3, 1620 København V, Denmark" → "København V"). Null when it can't tell.
 */
export function townOf(address: string | null | undefined): string | null {
  if (!address) return null;
  const parts = address.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const raw = parts[parts.length - 2];
  const town = raw.replace(/\b[A-Z]{1,3}-?\d{3,6}\b/g, "").replace(/\b\d[\d -]{2,8}\b/g, "").replace(/\s+\b[A-Z]{2}\b$/, "").replace(/\s+/g, " ").trim();
  return town && /\p{L}{2,}/u.test(town) ? town.slice(0, 80) : null;
}
