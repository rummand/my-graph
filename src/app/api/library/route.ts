import { NextResponse } from "next/server";
import { z } from "zod";
import { ingestFile, IngestError } from "@/lib/ingest";
import { jsonError, withViewer } from "@/lib/ingest/http";
import { LIBRARY_TYPES, listSources, type LibraryType } from "@/lib/ingest/library";
import { MAX_UPLOAD_BYTES } from "@/lib/ingest/mime";
import { assertFolderVisible } from "@/lib/ingest/folders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FILES = 20;

const listQuery = z.object({
  type: z.enum(LIBRARY_TYPES as [LibraryType, ...LibraryType[]]).optional(),
  status: z.enum(["pending", "processing", "ready", "failed"]).optional(),
  q: z.string().trim().max(200).optional(),
  thread: z.string().trim().min(1).max(1000).optional(),
  folder: z.union([z.literal("root"), z.string().uuid()]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).max(100_000).optional(),
});

/**
 * GET /api/library?type=&status=&q=&thread=&folder= — the sources the viewer can see, newest first. type also takes
 * mail, letter, scan, photo; folder is a folder id or "root" (not in a folder), ignored while searching.
 */
export async function GET(req: Request) {
  return withViewer(async (v) => {
    const params = Object.fromEntries(new URL(req.url).searchParams);
    for (const k of Object.keys(params)) if (params[k] === "") delete params[k];
    const f = listQuery.parse(params);
    const r = await listSources(v, { category: f.type, status: f.status, q: f.q, thread: f.thread, folder: f.folder, limit: f.limit, offset: f.offset });
    return NextResponse.json(r);
  });
}

const uploadFields = z.object({
  visibility: z.enum(["private", "parents", "household"]).default("private"),
  sensitive: z.enum(["true", "false", "on", "1", "0"]).optional().transform((s) => s === "true" || s === "on" || s === "1"),
  folderId: z.string().uuid("That isn't a valid folder.").optional(),
});

/** POST /api/library — multipart: one or more `file` fields, plus `visibility`, `sensitive` and an optional `folderId`. */
export async function POST(req: Request) {
  return withViewer(async (v) => {
    const len = Number(req.headers.get("content-length") ?? 0);
    if (len > MAX_UPLOAD_BYTES * MAX_FILES + 1024 * 1024) return jsonError(413, "That upload is too large. Send at most 20 files of up to 50 MB each.");
    if (!(req.headers.get("content-type") ?? "").includes("multipart/form-data")) return jsonError(415, "Send the files as multipart/form-data.");

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return jsonError(400, "The upload couldn't be read. Please try again.");
    }
    const fields = uploadFields.parse({ visibility: form.get("visibility") ?? undefined, sensitive: form.get("sensitive") ?? undefined, folderId: form.get("folderId") || undefined });
    const folderId = fields.folderId ? await assertFolderVisible(v, fields.folderId) : null;
    const files = form.getAll("file").filter((f): f is File => typeof f === "object" && f !== null && "arrayBuffer" in f);
    if (files.length === 0) return jsonError(400, "Choose at least one file to upload.");
    if (files.length > MAX_FILES) return jsonError(400, `Upload at most ${MAX_FILES} files at a time.`);

    const results: { name: string; sourceId?: string; duplicate?: boolean; error?: string }[] = [];
    for (const file of files) {
      try {
        const r = await ingestFile(v, file, { visibility: fields.visibility, sensitive: fields.sensitive, folderId });
        results.push({ name: file.name, ...r });
      } catch (e) {
        if (e instanceof IngestError) results.push({ name: file.name, error: e.message });
        else {
          console.error("[library upload]", e);
          results.push({ name: file.name, error: `"${file.name}" couldn't be saved. Please try again.` });
        }
      }
    }
    const ok = results.filter((r) => !r.error).length;
    if (ok === 0) return NextResponse.json({ error: results[0]?.error ?? "Nothing was uploaded.", results }, { status: results.length === 1 ? 415 : 400 });
    return NextResponse.json({ results }, { status: 201 });
  });
}
