/**
 * Dropbox, read-only (files.metadata.read, files.content.read), with the household's own Dropbox app. For each folder
 * the person chose: list_folder (recursive) the first time, then list_folder/continue with the saved cursor. A 409
 * "reset" means the cursor is no good: the one reset path lists the folder again, and files whose content hash didn't
 * change are not downloaded twice. New and changed files go through the reading queue like an upload.
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
import { apiArg, dropboxConflict, dropboxFiles, dropboxVersion, type DropboxCursor, type DropboxEntry, type DropboxPage } from "./map";

export const dropboxConfig = z.object({
  /** Folders the person chose ("" is the whole Dropbox). */
  folders: z.array(z.object({ id: z.string().max(300), name: z.string().max(300), path: z.string().max(1000) })).max(20).default([]),
  visibility,
  account,
});
export type DropboxConfig = z.infer<typeof dropboxConfig>;

export const dropboxManifest = defineManifest({
  id: "dropbox", version: "1", status: "official", icon: "folder",
  auth: { type: "oauth2" },
  config: dropboxConfig,
  secrets: oauthSecrets,
  fields: [{ key: "visibility", kind: "visibility" }],
  streams: [{ name: "files", key: "file id", cursor: "list_folder cursor per folder", resetOn: [409, "reset"] }],
  schedule: { everyMinutes: 60 },
  rateLimit: { perMinute: 300, backoff: "exponential" },
  maps: { files: "document" },
});

const MAX_FILES_PER_RUN = 60;
const MAX_PAGES = 30;

export async function syncDropbox(ctx: RunContext<DropboxConfig>, d: SyncDeps): Promise<void> {
  if (!ctx.config.folders.length) { ctx.log("No folder is chosen yet. Open the connection and choose folders in Dropbox."); return; }
  let cur: DropboxCursor = cursorOf<DropboxCursor>(ctx.state(), "files") ?? {};
  let left = MAX_FILES_PER_RUN;
  for (const folder of ctx.config.folders) {
    let saved = cur.folders?.[folder.path]?.cursor ?? null;
    for (let pages = 0; pages < MAX_PAGES; pages++) {
      const r = saved
        ? await d.api({ url: `${d.base.dropbox}/files/list_folder/continue`, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cursor: saved }) })
        : await d.api({ url: `${d.base.dropbox}/files/list_folder`, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: folder.path, recursive: true, include_deleted: false, limit: 500 }) });
      const conflict = dropboxConflict(r.status, r.body.toString("utf8").slice(0, 2000));
      if (conflict === "reset") throw new CursorExpired("files", "reset");
      if (conflict === "notFound") { ctx.log(`The Dropbox folder "${folder.name}" can't be found any more; choose it again.`); break; }
      if (r.status !== 200) throw unexpected(r, "Dropbox", `the folder "${folder.name}"`);
      const page = bodyOf<DropboxPage>(r, "Dropbox");
      for (const f of dropboxFiles(page.entries ?? [])) {
        if (left <= 0) { ctx.log("Stopped for now; more files come in the next run."); return; }
        if (await readFile(ctx, d, f)) left--;
      }
      saved = page.cursor ?? saved;
      cur = { folders: { ...(cur.folders ?? {}), [folder.path]: { cursor: saved } } };
      await d.sink.cursor(ctx as RunContext, "files", cur);
      if (!page.has_more) break;
    }
  }
}

async function readFile(ctx: RunContext<DropboxConfig>, d: SyncDeps, f: DropboxEntry): Promise<boolean> {
  const version = dropboxVersion(f);
  if ((await d.sink.fileVersion(ctx as RunContext, `dropbox:${f.id}`)) === version) { ctx.count("files", "unchanged"); return false; }
  if ((f.size ?? 0) > MAX_UPLOAD_BYTES) { ctx.log(`"${f.name}" is over 50 MB; it was left out.`); ctx.count("files", "skipped"); return false; }
  const r = await d.api({ url: `${d.base.dropboxContent}/files/download`, method: "POST", headers: { "dropbox-api-arg": apiArg({ path: f.id }), accept: "*/*" }, maxBytes: MAX_UPLOAD_BYTES + 1024, timeoutMs: 120_000 });
  if (r.status === 409) { ctx.count("files", "skipped"); return false; }
  if (r.status !== 200) throw unexpected(r, "Dropbox", `"${f.name}"`);
  ctx.count("files", "fetched");
  await d.sink.file(ctx as RunContext, "files", {
    externalId: `dropbox:${f.id}`, name: f.name, mime: null, bytes: new Uint8Array(r.body),
    modifiedAt: f.server_modified ? new Date(f.server_modified) : null, url: null, version, path: f.path_display ?? null, provider: "dropbox",
  }, ctx.config.visibility ?? "private");
  return true;
}
