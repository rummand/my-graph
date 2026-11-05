/**
 * GET /downloads/MyGraph-mac.zip: the My Graph for Mac menu bar app, when a build has been placed in
 * MG_DOWNLOADS_DIR (default ./downloads). Until then a plain 404. Signed-in people only (the middleware sends
 * everyone else to /login).
 */
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FILE = "MyGraph-mac.zip";

export async function GET() {
  const dir = resolve(process.env.MG_DOWNLOADS_DIR || join(process.cwd(), "downloads"));
  const path = join(dir, FILE);
  try {
    const s = await stat(path);
    if (!s.isFile()) throw new Error("not a file");
    const bytes = await readFile(path);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": "application/zip",
        "content-length": String(bytes.length),
        "content-disposition": `attachment; filename="${FILE}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return Response.json({ error: "The Mac app isn't available to download yet." }, { status: 404 });
  }
}
