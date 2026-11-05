/**
 * POST /api/connections/mac/upload (app token), multipart/form-data: `file`, `fileId` (the Mac's stable id for the
 * file), `relPath`, `folderLabel`, `modifiedAt?`, `source?` ("files" | "voiceMemos", default "files"). Kept like a
 * library upload, as the person, in the connection's graph; the same fileId with new bytes is stored as the next
 * version of that document, the same bytes again change nothing. 50 MB per file, rate limited.
 * → 201 { sourceId, outcome: "new" | "version", revision, title } or 200 { …, outcome: "unchanged" | "duplicate" }.
 */
import { ConnectionError } from "@/lib/connectors";
import { uploadFields } from "@/lib/connectors/mac/app";
import { uploadFile } from "@/lib/connectors/mac/app-server";
import { helperRoute } from "@/lib/connectors/mac/http";
import { MAX_UPLOAD_BYTES } from "@/lib/ingest/mime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = helperRoute(async (req, a) => {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_UPLOAD_BYTES + 1024 * 1024) throw new ConnectionError(413, "That file is too large. The limit is 50 MB per file.");
  if (!(req.headers.get("content-type") ?? "").includes("multipart/form-data")) throw new ConnectionError(415, "Send the file as multipart/form-data.");
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new ConnectionError(400, "The upload couldn't be read. Please try again.");
  }
  const file = form.get("file");
  if (!file || typeof file !== "object" || !("arrayBuffer" in file)) throw new ConnectionError(400, "Send the file in the `file` field.");
  const str = (k: string) => { const x = form.get(k); return typeof x === "string" && x !== "" ? x : undefined; };
  const f = uploadFields.safeParse({ fileId: str("fileId"), relPath: str("relPath"), modifiedAt: str("modifiedAt"), folderLabel: str("folderLabel"), source: str("source") });
  if (!f.success) throw new ConnectionError(400, f.error.issues[0]?.message ?? "Some fields need fixing.");
  const out = await uploadFile(a, file as File, f.data);
  return Response.json(out, { status: out.outcome === "new" || out.outcome === "version" ? 201 : 200, headers: { "cache-control": "no-store" } });
});
