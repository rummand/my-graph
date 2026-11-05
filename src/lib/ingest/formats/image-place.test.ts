import { describe, expect, it } from "vitest";
import type { ImportKnown } from "@/lib/importers/types";
import { exifMoment, readExif } from "./image";
import { photoPlaceOps, takenAtFallback } from "./image-place";

const place = (id: string, label: string, lat: number, lon: number): ImportKnown => ({ id, type: "place", kind: null, label, aliases: [], startAt: null, props: { lat, lon } });
let n = 0;
const mint = () => `id-${++n}`;

/** A tiny JPEG with EXIF date, offset and GPS, written with sharp. */
async function jpegWithExif(): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } }).jpeg().withExif({
    IFD0: { Make: "Apple", Model: "iPhone 15" },
    IFD2: { DateTimeOriginal: "2024:05:12 14:30:00", OffsetTimeOriginal: "+02:00" },
    IFD3: { GPSLatitudeRef: "N", GPSLatitude: "55/1 40/1 3396/100", GPSLongitudeRef: "E", GPSLongitude: "12/1 34/1 606/100" },
  }).toBuffer();
}

describe("EXIF: when and where", () => {
  it("reads date taken with its own offset, GPS and camera from a JPEG", async () => {
    const x = await readExif(await jpegWithExif());
    expect(x?.takenAt?.toISOString()).toBe("2024-05-12T12:30:00.000Z");
    expect(x?.lat).toBeCloseTo(55.6761, 4);
    expect(x?.lon).toBeCloseTo(12.56835, 4);
    expect(x?.camera).toBe("Apple iPhone 15");
  });

  it("places the camera clock by offset, else the GPS clock, else as UTC (never the server's zone)", () => {
    const local = new Date(2024, 4, 12, 14, 30, 0); // exifr hands the clock reading back in the server's zone
    expect(exifMoment({ DateTimeOriginal: local, OffsetTimeOriginal: "-05:00" })!.toISOString()).toBe("2024-05-12T19:30:00.000Z");
    expect(exifMoment({ DateTimeOriginal: local, GPSDateStamp: "2024:05:12", GPSTimeStamp: [12, 30, 5] })!.toISOString()).toBe("2024-05-12T12:30:05.000Z");
    expect(exifMoment({ DateTimeOriginal: local })!.toISOString()).toBe("2024-05-12T14:30:00.000Z");
    expect(exifMoment({})).toBeUndefined();
  });

  it("falls back on the time the source gave (Google Photos' createTime)", () => {
    expect(takenAtFallback({ takenAt: "2023-07-01T10:00:00Z" })).toMatchObject({ origin: "exif", precision: "minute" });
    expect(takenAtFallback({ takenAt: "nonsense" })).toBeNull();
    expect(takenAtFallback({})).toBeNull();
  });
});

describe("a photo's place", () => {
  const known = [place("tivoli", "Tivoli", 55.6737, 12.5681), place("zoo", "Zoo", 55.6725, 12.5213)];
  const base = { known, docNodeId: "doc-1", sourceId: "src-1", existingEdges: new Set<string>(), mint };

  it("links the photo to the nearest known place within 150 m, with a receipt", () => {
    const ops = photoPlaceOps({ ...base, meta: { exif: { lat: 55.6745, lon: 12.5683 } } });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: "addEdge", fromId: "doc-1", toId: "tivoli", relation: "located_at" });
    expect(ops[0].receipt).toMatchObject({ sourceId: "src-1", quote: "GPS 55.67450, 12.56830" });
  });

  it("proposes nothing far away, without GPS, or when the link exists", () => {
    expect(photoPlaceOps({ ...base, meta: { exif: { lat: 55.70, lon: 12.60 } } })).toEqual([]);
    expect(photoPlaceOps({ ...base, meta: { exif: { lat: null, lon: null } } })).toEqual([]);
    expect(photoPlaceOps({ ...base, meta: { exif: { lat: 55.6737, lon: 12.5681 } }, existingEdges: new Set(["doc-1|located_at|tivoli"]) })).toEqual([]);
  });
});
