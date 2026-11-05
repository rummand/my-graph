import { describe, expect, it } from "vitest";
import { validateManifest } from "../manifest";
import { deps, fakeApi, fakeCtx, memorySink } from "../oauth/testing";
import { durationMs, googlePhotosConfig, googlePhotosManifest, pendingSessions, photoMeta, photoName, syncGooglePhotos, type PhotosCursor } from "./photos";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);

/** A tiny Photos Picker: sessions that are picked or not, two pages of items, downloads on another host. */
function picker() {
  const state = {
    sessions: new Map<string, { mediaItemsSet: boolean; expireTime: string }>(),
    deleted: [] as string[],
    downloads: [] as { url: string; auth: boolean }[],
  };
  const items = [
    { id: "p1", createTime: "2024-05-04T09:12:00Z", type: "PHOTO", mediaFile: { baseUrl: "https://lh3.googleusercontent.com/abc1", mimeType: "image/jpeg", filename: "IMG_0001.JPG", mediaFileMetadata: { width: 4032, height: 3024, cameraMake: "Apple", cameraModel: "iPhone 15" } } },
    { id: "v1", createTime: "2024-05-04T09:13:00Z", type: "VIDEO", mediaFile: { baseUrl: "https://lh3.googleusercontent.com/vid", mimeType: "video/mp4", filename: "IMG_0002.MOV" } },
    { id: "p2", createTime: "2024-05-05T15:00:00Z", type: "PHOTO", mediaFile: { baseUrl: "https://lh3.googleusercontent.com/abc2", mimeType: "image/jpeg" } },
  ];
  const api = fakeApi((req) => {
    const { u } = req;
    if (u.host === "lh3.googleusercontent.com") {
      state.downloads.push({ url: req.url, auth: !req.noAuth });
      return { body: JPEG, headers: { "content-type": "image/jpeg" } };
    }
    const s = u.pathname.match(/^\/v1\/sessions\/(.+)$/);
    if (s) {
      const sess = state.sessions.get(decodeURIComponent(s[1]));
      if (req.method === "DELETE") { state.deleted.push(s[1]); return { json: {} }; }
      return sess ? { json: { id: s[1], ...sess } } : { status: 404, json: { error: { code: 404 } } };
    }
    if (u.pathname === "/v1/mediaItems") {
      if (!state.sessions.get(u.searchParams.get("sessionId") ?? "")?.mediaItemsSet) return { status: 400, json: {} };
      const page = u.searchParams.get("pageToken");
      return page ? { json: { mediaItems: items.slice(2) } } : { json: { mediaItems: items.slice(0, 2), nextPageToken: "n2" } };
    }
    return undefined;
  });
  return { api, state };
}

const config = (ids: string[]) => googlePhotosConfig.parse({ sessions: ids.map((id) => ({ id, createdAt: "2026-11-04T09:00:00Z" })) });

describe("google photos manifest and mapping", () => {
  it("is valid", () => expect(validateManifest(googlePhotosManifest)).toEqual({ ok: true }));

  it("keeps the time taken and camera, names files, reads Google durations", () => {
    expect(photoMeta({ id: "x", createTime: "2024-05-04T09:12:00Z", mediaFile: { mediaFileMetadata: { width: 10, height: 20, cameraMake: "Apple", cameraModel: "iPhone 15" } } }))
      .toEqual({ takenAt: "2024-05-04T09:12:00.000Z", googlePhotos: { id: "x", width: 10, height: 20, camera: "Apple iPhone 15" } });
    expect(photoMeta({ id: "y" })).toEqual({ googlePhotos: { id: "y", width: null, height: null, camera: null } });
    expect(photoName({ id: "abcdefghijklmnop", mediaFile: { mimeType: "image/heic" } })).toBe("Google Photos abcdefghijkl.heic");
    expect(durationMs("5s", 3000)).toBe(5000);
    expect(durationMs("0.2s", 3000)).toBe(1000);
    expect(durationMs(undefined, 3000)).toBe(3000);
    expect(pendingSessions(config(["a", "b"]), { done: ["a"] }).map((s) => s.id)).toEqual(["b"]);
  });
});

describe("google photos sync", () => {
  it("waits while the person is still picking", async () => {
    const g = picker();
    g.state.sessions.set("s1", { mediaItemsSet: false, expireTime: "2026-11-04T11:00:00Z" });
    const sink = memorySink();
    const ctx = fakeCtx("google_photos", config(["s1"]));
    await syncGooglePhotos(ctx, deps(g.api, sink));
    expect(sink.rec.files).toHaveLength(0);
    expect(g.state.deleted).toEqual([]);
    expect(ctx.logs.join(" ")).toContain("Waiting");
  });

  it("brings in picked photos with =d and the token, leaves videos out, then deletes the session", async () => {
    const g = picker();
    g.state.sessions.set("s1", { mediaItemsSet: true, expireTime: "2026-11-04T11:00:00Z" });
    const sink = memorySink();
    const ctx = fakeCtx("google_photos", config(["s1"]));
    await syncGooglePhotos(ctx, deps(g.api, sink));
    expect(g.state.downloads).toEqual([
      { url: "https://lh3.googleusercontent.com/abc1=d", auth: true },
      { url: "https://lh3.googleusercontent.com/abc2=d", auth: true },
    ]);
    expect(sink.rec.files.map((f) => f.externalId)).toEqual(["gphotos:p1", "gphotos:p2"]);
    const f = sink.rec.files[0];
    expect(f).toMatchObject({ name: "IMG_0001.JPG", mime: "image/jpeg", version: "p1", provider: "google_photos" });
    expect(f.modifiedAt?.toISOString()).toBe("2024-05-04T09:12:00.000Z");
    expect(f.extraMeta).toMatchObject({ takenAt: "2024-05-04T09:12:00.000Z", googlePhotos: { camera: "Apple iPhone 15" } });
    expect(ctx.counts.photos).toMatchObject({ skipped: 1, fetched: 2, added: 2 });
    expect(ctx.logs.join(" ")).toContain("1 video was left out");
    expect(g.state.deleted).toEqual(["s1"]);
    expect((ctx.state().streams?.photos?.cursor as PhotosCursor).done).toEqual(["s1"]);

    // The next run has nothing left to do for that session.
    const before = g.api.calls.length;
    await syncGooglePhotos(ctx, deps(g.api, sink));
    expect(g.api.calls.length).toBe(before);
  });

  it("drops an expired session with a line in the log", async () => {
    const g = picker();
    g.state.sessions.set("old", { mediaItemsSet: false, expireTime: "2026-11-04T09:00:00Z" });
    const sink = memorySink();
    const ctx = fakeCtx("google_photos", config(["gone", "old"]));
    await syncGooglePhotos(ctx, deps(g.api, sink));
    expect((ctx.state().streams?.photos?.cursor as PhotosCursor).done).toEqual(["gone", "old"]);
    expect(ctx.logs.join(" ")).toContain("expired");
    expect(ctx.logs.join(" ")).toContain("ended without photos");
    expect(sink.rec.files).toHaveLength(0);
  });
});
