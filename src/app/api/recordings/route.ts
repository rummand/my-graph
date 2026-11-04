import { z } from "zod";
import { listRecordings } from "@/lib/connectors/record/recordings";
import { recordingsRoute } from "@/lib/connectors/record/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const query = z.object({ q: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(500).optional() });

/** GET ?q&limit: the recordings the viewer may read in this graph, newest first. */
export const GET = recordingsRoute(async (req, v) => {
  const p = query.parse(Object.fromEntries(new URL(req.url).searchParams));
  return { recordings: await listRecordings(v, p) };
});
