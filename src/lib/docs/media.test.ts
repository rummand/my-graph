import { describe, expect, it } from "vitest";
import { FILM } from "./film";
import { isAllowedMedia, mediaDir, mediaPath, mediaType, parseRange, tokenMatches } from "./media";

describe("allow-list", () => {
  it("serves the film's files", () => {
    expect(isAllowedMedia(FILM.video)).toBe(true);
    expect(isAllowedMedia(FILM.poster)).toBe(true);
    expect(isAllowedMedia(FILM.vtt)).toBe(true);
    expect(isAllowedMedia(FILM.srt)).toBe(true);
    expect(isAllowedMedia(FILM.chapters)).toBe(true);
  });
  it("refuses anything else", () => {
    for (const bad of ["", "../.env", "..%2F.env", "/etc/passwd", `../${FILM.video}`, `${FILM.video}/`, `docs/${FILM.video}`,
      "my-graph-explained.MP4", "other.mp4", "shot-../x.jpg", ".", "..", null, undefined, 42]) {
      expect(isAllowedMedia(bad)).toBe(false);
    }
  });
  it("only gives paths for allowed names, inside the media folder", () => {
    expect(mediaPath(FILM.video, "/data/uploads/docs")).toBe(`/data/uploads/docs/${FILM.video}`);
    expect(mediaPath("../secret", "/data/uploads/docs")).toBeNull();
  });
  it("finds the folder", () => {
    expect(mediaDir({ DOCS_MEDIA_DIR: "/srv/docs" })).toBe("/srv/docs");
    expect(mediaDir({ UPLOAD_DIR: "/data/uploads" })).toBe("/data/uploads/docs");
  });
  it("names the types", () => {
    expect(mediaType("a.mp4")).toBe("video/mp4");
    expect(mediaType("a.vtt")).toMatch(/^text\/vtt/);
    expect(mediaType("a.jpg")).toBe("image/jpeg");
  });
});

describe("parseRange", () => {
  const size = 1000;
  it("ignores a missing or unusable header", () => {
    expect(parseRange(null, size)).toBeNull();
    expect(parseRange("", size)).toBeNull();
    expect(parseRange("bytes=-", size)).toBeNull();
    expect(parseRange("items=0-5", size)).toBeNull();
    expect(parseRange("bytes=0-1,5-9", size)).toBeNull();
    expect(parseRange("bytes=9-5", size)).toBeNull();
  });
  it("reads open, closed and suffix ranges", () => {
    expect(parseRange("bytes=0-", size)).toEqual({ start: 0, end: 999 });
    expect(parseRange("bytes=0-1", size)).toEqual({ start: 0, end: 1 });
    expect(parseRange("bytes=100-199", size)).toEqual({ start: 100, end: 199 });
    expect(parseRange("bytes=900-5000", size)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=-100", size)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=-5000", size)).toEqual({ start: 0, end: 999 });
  });
  it("refuses a range past the end", () => {
    expect(parseRange("bytes=1000-", size)).toBe("unsatisfiable");
    expect(parseRange("bytes=5000-6000", size)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", size)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-", 0)).toBe("unsatisfiable");
  });
});

describe("tokenMatches", () => {
  const secret = "a-long-upload-secret-123";
  it("accepts the right bearer token", () => {
    expect(tokenMatches(`Bearer ${secret}`, secret)).toBe(true);
    expect(tokenMatches(`bearer   ${secret}  `, secret)).toBe(true);
  });
  it("refuses a wrong, missing or partial token", () => {
    expect(tokenMatches(`Bearer ${secret}x`, secret)).toBe(false);
    expect(tokenMatches(`Bearer ${secret.slice(0, -1)}`, secret)).toBe(false);
    expect(tokenMatches(secret, secret)).toBe(false);
    expect(tokenMatches("Basic abc", secret)).toBe(false);
    expect(tokenMatches(null, secret)).toBe(false);
    expect(tokenMatches("", secret)).toBe(false);
  });
  it("is off when no secret, or a short one, is configured", () => {
    expect(tokenMatches("Bearer ", "")).toBe(false);
    expect(tokenMatches("Bearer x", undefined)).toBe(false);
    expect(tokenMatches("Bearer short", "short")).toBe(false);
  });
});
