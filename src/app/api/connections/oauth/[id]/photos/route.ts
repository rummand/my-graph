import { z } from "zod";
import { ConnectionError } from "@/lib/connectors";
import { parseId, route } from "@/lib/connectors/http";
import { createPhotosSession, photosSessionStatus } from "@/lib/connectors/google/photos-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

/**
 * POST → open a Google Photos picking session for this connection: { sessionId, pickerUri, pollMs, timeoutMs }. The
 * person picks in Google's own page; the token never leaves the server.
 */
export const POST = route<{ params: Promise<{ id: string }> }>(async (_req, v, { params }) => {
  const id = parseId((await params).id);
  return Response.json(await createPhotosSession(v, id), { headers: NO_STORE });
});

const query = z.object({ session: z.string().trim().min(1).max(300) });

/** GET ?session=<id> → { state: picking | picked | read | expired }; "picked" starts the connection's run. */
export const GET = route<{ params: Promise<{ id: string }> }>(async (req, v, { params }) => {
  const id = parseId((await params).id);
  const q = query.safeParse({ session: new URL(req.url).searchParams.get("session") ?? undefined });
  if (!q.success) throw new ConnectionError(400, "Say which picking session.");
  return Response.json(await photosSessionStatus(v, id, q.data.session), { headers: NO_STORE });
});
