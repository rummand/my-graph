import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, withViewer } from "@/lib/ingest/http";
import { addPastedText, addPastedUrl } from "@/lib/ingest/paste";
import { assertFolderVisible, moveFiles } from "@/lib/ingest/folders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const sharing = {
  visibility: z.enum(["private", "parents", "household"]).default("private"),
  sensitive: z.boolean().default(false),
  folderId: z.string().uuid("That isn't a valid folder.").nullish(),
};

const body = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    title: z.string().trim().min(1, "Give the note a title.").max(200, "Keep the title under 200 characters."),
    text: z.string().min(1, "There is no text to save.").max(200_000, "That is a lot of text. Save it as a file instead (up to 50 MB)."),
    sourceUrl: z.string().trim().url().max(2000).nullish(),
    ...sharing,
  }).strict(),
  z.object({
    kind: z.literal("url"),
    url: z.string().trim().url("That isn't a web address.").max(2000).refine((u) => /^https?:\/\//i.test(u), "Only web addresses (http or https) can be saved."),
    title: z.string().trim().max(300).nullish(),
    ...sharing,
  }).strict(),
]);

/**
 * POST /api/library/paste — something pasted into the library that isn't a file.
 *   { kind: "text", title, text, sourceUrl?, visibility, sensitive } → a note, read like an upload.
 *   { kind: "url", url, title?, visibility, sensitive }              → the page read and saved as a web source.
 * → 201 { sourceId, duplicate, title, read } (read: false when only the link could be saved).
 */
export async function POST(req: Request) {
  return withViewer(async (v) => {
    if (!(req.headers.get("content-type") ?? "").includes("application/json")) return jsonError(415, "Send the paste as JSON.");
    let raw: unknown;
    try { raw = await req.json(); } catch { return jsonError(400, "The paste couldn't be read. Please try again."); }
    const b = body.parse(raw);
    const folderId = b.folderId ? await assertFolderVisible(v, b.folderId) : null;
    const r = b.kind === "text"
      ? await addPastedText(v, { title: b.title, text: b.text, sourceUrl: b.sourceUrl, visibility: b.visibility, sensitive: b.sensitive })
      : await addPastedUrl(v, { url: b.url, title: b.title, visibility: b.visibility, sensitive: b.sensitive, signal: req.signal });
    // Saved while looking at a folder: it goes there (a note or page already here stays where it is).
    if (folderId && !r.duplicate && r.sourceId) await moveFiles(v, [r.sourceId], folderId).catch(() => null);
    return NextResponse.json(r, { status: r.duplicate ? 200 : 201 });
  });
}
