/**
 * Where and when an uploaded photo was taken, turned into proposals (pure, unit-tested). A photo whose EXIF puts it
 * within 150 m of a place the graph knows (props.lat / props.lon) gets one proposed `located_at` link to the nearest
 * such place, with a receipt quoting the coordinates. Coordinates stay in the graph: no geocoding service is asked.
 */
import type { ChangeInput } from "@/lib/changes";
import { fmtCoords, nearestPlace, validLatLon } from "@/lib/importers/geo";
import { edgeKey } from "@/lib/importers/match";
import type { ImportKnown } from "@/lib/importers/types";
import type { DateCandidate } from "../document-date";

export const PHOTO_PLACE_M = 150;

type Exif = { takenAt?: string | null; lat?: number | null; lon?: number | null } | null | undefined;

/** The photo's coordinates from what extraction stored in meta.exif. */
export function photoCoords(meta: Record<string, unknown>): { lat: number; lon: number } | null {
  const x = meta.exif as Exif;
  return x && validLatLon(x.lat ?? null, x.lon ?? null) ? { lat: x.lat!, lon: x.lon! } : null;
}

/**
 * When the picture has no EXIF date: the time the place it came from gives (Google Photos' createTime, kept as
 * meta.takenAt by the connector). Same weight as EXIF: it is the photo's own record of when it was taken.
 */
export function takenAtFallback(meta: Record<string, unknown>): DateCandidate | null {
  const s = typeof meta.takenAt === "string" ? meta.takenAt : null;
  const at = s ? new Date(s) : null;
  return at && !Number.isNaN(at.getTime()) ? { at, precision: "minute", origin: "exif" } : null;
}

/** The proposed link from the photo's document node to the known place it was taken at, if any. */
export function photoPlaceOps(o: {
  meta: Record<string, unknown>; known: ImportKnown[]; docNodeId: string | null; sourceId: string;
  existingEdges: ReadonlySet<string>; mint: () => string;
}): ChangeInput[] {
  const at = photoCoords(o.meta);
  if (!at || !o.docNodeId) return [];
  const near = nearestPlace(o.known, at, PHOTO_PLACE_M);
  if (!near || o.existingEdges.has(edgeKey(o.docNodeId, "located_at", near.place.id))) return [];
  const m = Math.round(near.distanceM);
  return [{
    op: "addEdge", edgeId: o.mint(), fromId: o.docNodeId, toId: near.place.id, relation: "located_at", confidence: m <= 50 ? 0.9 : 0.75,
    note: `Taken ${m} m from ${near.place.label}, by the photo's own GPS position.`,
    receipt: { sourceId: o.sourceId, quote: `GPS ${fmtCoords(at)}`, locator: { image: "exif" }, confidence: m <= 50 ? 0.9 : 0.75 },
  }];
}
