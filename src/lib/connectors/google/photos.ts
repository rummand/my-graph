/**
 * Google Photos through Google's Photos Picker (photospicker.mediaitems.readonly). The Library API no longer lists a
 * person's library to other apps, so nothing is read in the background: the person opens a picker session from the
 * connection (POST /api/connections/oauth/[id]/photos), picks photos in Google's own page, and the next run brings in
 * exactly those.
 *   A session is kept in config.sessions until it is read; the cursor remembers which sessions are done.
 *   A run: for each pending session, ask Google whether picking finished (mediaItemsSet). When it has, page through
 *   the picked items, download each photo (baseUrl=d, with the connection's token) into the library as an upload
 *   (externalId gphotos:<id>, its createTime kept as meta.takenAt so the photo has a date even without EXIF), then
 *   delete the session at Google. Videos are left out with a line in the log. An expired session is dropped.
 * Only types here: the sync takes its API and sink from the caller, so the tests run without a database or network.
 */
import { z } from "zod";
import { defineManifest } from "../manifest";
import { cursorOf } from "../state";
import type { RunContext } from "../types";
import { bodyOf, unexpected } from "../oauth/client";
import type { SyncDeps } from "../oauth/deps";
import { account, oauthSecrets, visibility } from "../oauth/fields";
import { MAX_UPLOAD_BYTES } from "@/lib/ingest/mime";

export const MAX_SESSIONS = 5;
const MAX_PHOTOS_PER_RUN = 100;
const DONE_KEPT = 50;

export const pickerSession = z.object({ id: z.string().trim().min(1).max(300), createdAt: z.string().max(40) });
export type PickerSession = z.infer<typeof pickerSession>;

export const googlePhotosConfig = z.object({
  /** Picker sessions opened from the connection and not read yet (newest last). */
  sessions: z.array(pickerSession).max(MAX_SESSIONS).default([]),
  visibility,
  account,
});
export type GooglePhotosConfig = z.infer<typeof googlePhotosConfig>;

export const googlePhotosManifest = defineManifest({
  id: "google_photos", version: "1", status: "official", icon: "photo",
  auth: { type: "oauth2" },
  config: googlePhotosConfig,
  secrets: oauthSecrets,
  fields: [{ key: "visibility", kind: "visibility" }],
  streams: [{ name: "photos", key: "mediaItemId", cursor: "picker sessions read", resetOn: [404] }],
  schedule: { everyMinutes: 60 },
  rateLimit: { perMinute: 300, backoff: "exponential" },
  maps: { photos: "photo" },
});

export type PhotosCursor = { done?: string[] };

/** A picker session as Google describes it. */
export type PickingSession = {
  id: string;
  pickerUri?: string;
  mediaItemsSet?: boolean;
  expireTime?: string;
  pollingConfig?: { pollInterval?: string; timeoutIn?: string };
};

export type PickedMediaItem = {
  id: string;
  createTime?: string;
  type?: "PHOTO" | "VIDEO" | "TYPE_UNSPECIFIED" | string;
  mediaFile?: {
    baseUrl?: string;
    mimeType?: string;
    filename?: string;
    mediaFileMetadata?: { width?: number; height?: number; cameraMake?: string; cameraModel?: string };
  };
};

/** "5s" / "1.5s" → milliseconds (Google's Duration), clamped to something sensible for polling. */
export function durationMs(d: string | undefined, fallback: number, min = 1000, max = 60_000): number {
  const m = (d ?? "").match(/^(\d+(?:\.\d+)?)s$/);
  const n = m ? Math.round(Number(m[1]) * 1000) : fallback;
  return Math.min(max, Math.max(min, n));
}

/** What the library keeps about a picked photo (createTime as takenAt, so the photo has a date without EXIF). */
export function photoMeta(item: PickedMediaItem): Record<string, unknown> {
  const md = item.mediaFile?.mediaFileMetadata ?? {};
  const camera = [md.cameraMake, md.cameraModel].filter((s) => typeof s === "string" && s.trim()).join(" ").trim() || null;
  const when = item.createTime && !Number.isNaN(Date.parse(item.createTime)) ? new Date(item.createTime).toISOString() : null;
  return {
    ...(when ? { takenAt: when } : {}),
    googlePhotos: { id: item.id, width: md.width ?? null, height: md.height ?? null, camera },
  };
}

/** A file name for the library: Google's own, else one made from the id and type. */
export function photoName(item: PickedMediaItem): string {
  const n = item.mediaFile?.filename?.trim();
  if (n) return n.slice(0, 250);
  const ext = (item.mediaFile?.mimeType ?? "").split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "jpg";
  return `Google Photos ${item.id.slice(0, 12)}.${ext}`;
}

/** The sessions still to read: those in the config that the cursor doesn't list as done. */
export function pendingSessions(config: GooglePhotosConfig, cur: PhotosCursor | null): PickerSession[] {
  const done = new Set(cur?.done ?? []);
  return (config.sessions ?? []).filter((s) => !done.has(s.id));
}

type Run = { ctx: RunContext<GooglePhotosConfig>; d: SyncDeps; left: number; cur: PhotosCursor };

async function markDone(run: Run, id: string): Promise<void> {
  run.cur = { ...run.cur, done: [...(run.cur.done ?? []).filter((x) => x !== id), id].slice(-DONE_KEPT) };
  await run.d.sink.cursor(run.ctx as RunContext, "photos", run.cur);
}

/** Read one finished session. Returns false when the run's cap stopped it (the rest comes next run). */
async function readSession(run: Run, sessionId: string): Promise<boolean> {
  const { ctx, d } = run;
  let pageToken: string | null = null;
  let videos = 0;
  do {
    const q = new URLSearchParams({ sessionId, pageSize: "100" });
    if (pageToken) q.set("pageToken", pageToken);
    const r = await d.api({ url: `${d.base.photosPicker}/mediaItems?${q}` });
    if (r.status === 404 || r.status === 400) { ctx.log("The picked photos are no longer available at Google; pick them again."); return true; }
    if (r.status !== 200) throw unexpected(r, "Google", "the picked photos");
    const page = bodyOf<{ mediaItems?: PickedMediaItem[]; nextPageToken?: string }>(r, "Google");
    for (const item of page.mediaItems ?? []) {
      if (item.type && item.type !== "PHOTO") { videos++; ctx.count("photos", "skipped"); continue; }
      const baseUrl = item.mediaFile?.baseUrl;
      if (!baseUrl) { ctx.count("photos", "skipped"); continue; }
      const externalId = `gphotos:${item.id}`;
      if ((await d.sink.fileVersion(ctx as RunContext, externalId)) === item.id) { ctx.count("photos", "unchanged"); continue; }
      if (run.left <= 0) return false;
      run.left--;
      const dl = await d.api({ url: `${baseUrl}=d`, maxBytes: MAX_UPLOAD_BYTES + 1024, timeoutMs: 120_000, headers: { accept: "*/*" } });
      if (dl.status === 404 || dl.status === 403) { ctx.log(`"${photoName(item)}" couldn't be downloaded (HTTP ${dl.status}).`); ctx.count("photos", "skipped"); continue; }
      if (dl.status !== 200) throw unexpected(dl, "Google", `"${photoName(item)}"`);
      ctx.count("photos", "fetched");
      await d.sink.file(ctx as RunContext, "photos", {
        externalId, name: photoName(item), mime: item.mediaFile?.mimeType ?? null, bytes: new Uint8Array(dl.body),
        modifiedAt: item.createTime ? new Date(item.createTime) : null, url: null, version: item.id, provider: "google_photos",
        extraMeta: photoMeta(item),
      }, ctx.config.visibility ?? "private");
    }
    pageToken = page.nextPageToken ?? null;
  } while (pageToken);
  if (videos) ctx.log(videos === 1 ? "1 video was left out; My Graph brings in photos only." : `${videos} videos were left out; My Graph brings in photos only.`);
  return true;
}

export async function syncGooglePhotos(ctx: RunContext<GooglePhotosConfig>, d: SyncDeps): Promise<void> {
  const run: Run = { ctx, d, left: MAX_PHOTOS_PER_RUN, cur: { ...(cursorOf<PhotosCursor>(ctx.state(), "photos") ?? {}) } };
  const pending = pendingSessions(ctx.config, run.cur);
  if (!pending.length) { ctx.log("Nothing to bring in. Open the connection and pick photos in Google Photos."); return; }
  for (const s of pending) {
    const r = await d.api({ url: `${d.base.photosPicker}/sessions/${encodeURIComponent(s.id)}` });
    if (r.status === 404) { ctx.log("A picking session had expired before it was read; pick those photos again."); await markDone(run, s.id); continue; }
    if (r.status !== 200) throw unexpected(r, "Google", "the picking session");
    const session = bodyOf<PickingSession>(r, "Google");
    if (!session.mediaItemsSet) {
      if (session.expireTime && Date.parse(session.expireTime) < ctx.now.getTime()) {
        ctx.log("A picking session ended without photos being picked.");
        await d.api({ url: `${d.base.photosPicker}/sessions/${encodeURIComponent(s.id)}`, method: "DELETE" }).catch(() => null);
        await markDone(run, s.id);
      } else {
        ctx.log("Waiting for you to finish picking in Google Photos.");
      }
      continue;
    }
    if (!(await readSession(run, s.id))) { ctx.log("Stopped for now; the rest of the picked photos come in the next run."); return; }
    // Read: Google no longer needs to keep the picked items for us.
    await d.api({ url: `${d.base.photosPicker}/sessions/${encodeURIComponent(s.id)}`, method: "DELETE" }).catch(() => null);
    await markDone(run, s.id);
  }
}
