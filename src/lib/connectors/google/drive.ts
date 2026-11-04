/**
 * Google Drive with drive.file: My Graph sees only what the person picks in Google's own picker (files, or folders).
 *   Before the first read the changes position (startPageToken) is noted, so nothing changed meanwhile is missed.
 *   Each newly picked item is read once in full (a folder: its files, and folders inside it, a few levels deep).
 *   After that: changes.list from the saved position; a changed file in scope (picked, or inside a picked folder) is
 *   read again, an unchanged one (same checksum or version) is never downloaded twice. A 404/410 on the position
 *   means it expired: the one reset path notes a new position and reads every picked item again (skipping what
 *   didn't change).
 * Files go through the reading queue like an upload: Google Docs are exported as Word, Sheets as Excel, Slides as
 * PowerPoint; other Google formats (forms, drawings, maps) are left out with a line in the log.
 */
import { z } from "zod";
import { CursorExpired } from "../errors";
import { defineManifest } from "../manifest";
import { cursorOf } from "../state";
import type { RunContext } from "../types";
import { bodyOf, unexpected } from "../oauth/client";
import type { SyncDeps } from "../oauth/deps";
import { account, oauthSecrets, visibility } from "../oauth/fields";
import { MAX_UPLOAD_BYTES } from "@/lib/ingest/mime";
import { driveExport, driveInScope, driveName, driveVersion, FOLDER_MIME, type DriveCursor, type DriveFile } from "./map";

export const pickedItem = z.object({ id: z.string().trim().min(1).max(200), name: z.string().max(300), mimeType: z.string().max(200) });

export const googleDriveConfig = z.object({
  /** What the person picked in the Google picker (files and folders). */
  picked: z.array(pickedItem).max(50).default([]),
  visibility,
  account,
});
export type GoogleDriveConfig = z.infer<typeof googleDriveConfig>;

export const googleDriveManifest = defineManifest({
  id: "google_drive", version: "1", status: "official", icon: "folder",
  auth: { type: "oauth2" },
  config: googleDriveConfig,
  secrets: oauthSecrets,
  fields: [{ key: "visibility", kind: "visibility" }],
  streams: [{ name: "files", key: "fileId", cursor: "changes pageToken + picked items read", resetOn: [404, 410] }],
  schedule: { everyMinutes: 60 },
  rateLimit: { perMinute: 300, backoff: "exponential" },
  maps: { files: "document" },
});

const FILE_FIELDS = "id,name,mimeType,parents,md5Checksum,modifiedTime,version,size,trashed,webViewLink";
const MAX_FILES_PER_RUN = 60;
const MAX_DEPTH = 4;

type Run = { ctx: RunContext<GoogleDriveConfig>; d: SyncDeps; left: number; cur: DriveCursor };

async function readFile(run: Run, f: DriveFile): Promise<void> {
  const { ctx, d } = run;
  if (f.trashed) return;
  const exp = driveExport(f.mimeType);
  if (!exp) { if (f.mimeType !== FOLDER_MIME) { ctx.log(`"${f.name}" is a Google format My Graph can't read; it was left out.`); ctx.count("files", "skipped"); } return; }
  const version = driveVersion(f);
  if ((await d.sink.fileVersion(ctx as RunContext, `gdrive:${f.id}`)) === version) { ctx.count("files", "unchanged"); return; }
  if (exp === "download" && Number(f.size ?? 0) > MAX_UPLOAD_BYTES) { ctx.log(`"${f.name}" is over 50 MB; it was left out.`); ctx.count("files", "skipped"); return; }
  if (run.left <= 0) return;
  run.left--;
  const url = exp === "download"
    ? `${d.base.drive}/files/${encodeURIComponent(f.id)}?alt=media`
    : `${d.base.drive}/files/${encodeURIComponent(f.id)}/export?mimeType=${encodeURIComponent(exp.mime)}`;
  const r = await d.api({ url, maxBytes: MAX_UPLOAD_BYTES + 1024, timeoutMs: 120_000, headers: { accept: "*/*" } });
  if (r.status === 404 || r.status === 403) { ctx.log(`"${f.name}" can no longer be read (HTTP ${r.status}).`); ctx.count("files", "skipped"); return; }
  if (r.status !== 200) throw unexpected(r, "Google", `"${f.name}"`);
  ctx.count("files", "fetched");
  await d.sink.file(ctx as RunContext, "files", {
    externalId: `gdrive:${f.id}`, name: driveName(f, exp), mime: exp === "download" ? f.mimeType : exp.mime, bytes: new Uint8Array(r.body),
    modifiedAt: f.modifiedTime ? new Date(f.modifiedTime) : null, url: f.webViewLink ?? null, version, provider: "google_drive",
  }, ctx.config.visibility ?? "private");
}

/** Every file in a picked folder (and folders inside it, up to MAX_DEPTH levels). */
async function readFolder(run: Run, folderId: string, depth: number): Promise<boolean> {
  const { d } = run;
  let pageToken: string | null = null;
  run.cur.folders = [...new Set([...(run.cur.folders ?? []), folderId])];
  do {
    const q = new URLSearchParams({ q: `'${folderId.replace(/'/g, "")}' in parents and trashed = false`, fields: `nextPageToken,files(${FILE_FIELDS})`, pageSize: "100" });
    if (pageToken) q.set("pageToken", pageToken);
    const r = await d.api({ url: `${d.base.drive}/files?${q}` });
    if (r.status === 404) { run.ctx.log("A picked folder can no longer be read; pick it again."); return true; }
    if (r.status !== 200) throw unexpected(r, "Google", "a picked folder");
    const page = bodyOf<{ files?: DriveFile[]; nextPageToken?: string }>(r, "Google");
    for (const f of page.files ?? []) {
      if (f.mimeType === FOLDER_MIME) { if (depth < MAX_DEPTH && !(await readFolder(run, f.id, depth + 1))) return false; continue; }
      await readFile(run, f);
      if (run.left <= 0) return false;
    }
    pageToken = page.nextPageToken ?? null;
  } while (pageToken);
  return true;
}

export async function syncGoogleDrive(ctx: RunContext<GoogleDriveConfig>, d: SyncDeps): Promise<void> {
  const saved = cursorOf<DriveCursor>(ctx.state(), "files");
  const run: Run = { ctx, d, left: MAX_FILES_PER_RUN, cur: { ...(saved ?? {}) } };
  const picked = ctx.config.picked ?? [];
  if (!picked.length) { ctx.log("Nothing is picked yet. Open the connection and pick files or folders in Google Drive."); return; }

  if (!run.cur.pageToken) {
    const r = await d.api({ url: `${d.base.drive}/changes/startPageToken` });
    if (r.status !== 200) throw unexpected(r, "Google", "Drive's change position");
    run.cur = { pageToken: bodyOf<{ startPageToken: string }>(r, "Google").startPageToken, seeded: [], folders: [] };
    await d.sink.cursor(ctx as RunContext, "files", run.cur);
  }

  // Newly picked items, read once in full.
  for (const p of picked) {
    if (run.cur.seeded?.includes(p.id)) continue;
    if (p.mimeType === FOLDER_MIME) {
      if (!(await readFolder(run, p.id, 1))) { await d.sink.cursor(ctx as RunContext, "files", run.cur); ctx.log("Stopped for now; the rest comes in the next run."); return; }
    } else {
      const r = await d.api({ url: `${d.base.drive}/files/${encodeURIComponent(p.id)}?fields=${encodeURIComponent(FILE_FIELDS)}` });
      if (r.status === 404 || r.status === 403) { ctx.log(`"${p.name}" can no longer be read; pick it again.`); ctx.count("files", "skipped"); }
      else if (r.status !== 200) throw unexpected(r, "Google", `"${p.name}"`);
      else await readFile(run, bodyOf<DriveFile>(r, "Google"));
      if (run.left <= 0) { await d.sink.cursor(ctx as RunContext, "files", run.cur); return; }
    }
    run.cur = { ...run.cur, seeded: [...new Set([...(run.cur.seeded ?? []), p.id])] };
    await d.sink.cursor(ctx as RunContext, "files", run.cur);
  }

  // What changed since the saved position.
  const pickedIds = new Set(picked.map((p) => p.id));
  for (;;) {
    const q = new URLSearchParams({ pageToken: run.cur.pageToken!, pageSize: "100", includeRemoved: "true", spaces: "drive", fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FILE_FIELDS}))` });
    const r = await d.api({ url: `${d.base.drive}/changes?${q}` });
    if (r.status === 404 || r.status === 410) throw new CursorExpired("files", r.status);
    if (r.status !== 200) throw unexpected(r, "Google", "what changed in Drive");
    const page = bodyOf<{ changes?: { fileId: string; removed?: boolean; file?: DriveFile }[]; nextPageToken?: string; newStartPageToken?: string }>(r, "Google");
    const folders = new Set(run.cur.folders ?? []);
    for (const ch of page.changes ?? []) {
      const f = ch.file;
      if (ch.removed || !f || f.trashed) continue; // what was brought in stays; removing it is the person's call
      if (!driveInScope(f, pickedIds, folders)) continue;
      if (f.mimeType === FOLDER_MIME) { folders.add(f.id); continue; }
      await readFile(run, f);
      if (run.left <= 0) { ctx.log("Stopped for now; more changes come in the next run."); return; }
    }
    run.cur = { ...run.cur, folders: [...folders], pageToken: page.nextPageToken ?? page.newStartPageToken ?? run.cur.pageToken };
    await d.sink.cursor(ctx as RunContext, "files", run.cur);
    if (!page.nextPageToken) return;
  }
}
