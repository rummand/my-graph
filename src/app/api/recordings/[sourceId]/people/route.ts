import { z } from "zod";
import { scopeOf } from "@/lib/graphs/pure";
import { proposeSpeaker } from "@/lib/connectors/record/recordings";
import { RecordingsError, recordingsRoute, sourceIdOf } from "@/lib/connectors/record/http";

export const runtime = "nodejs";

const body = z.object({ name: z.string().trim().min(1).max(120) });

/** POST { name }: propose a speaker as a person in this graph (a change set, linked to the meeting when it is there). */
export const POST = recordingsRoute(async (req, v, { params }: { params: Promise<{ sourceId: string }> }) => {
  const id = await sourceIdOf(params);
  if (v.role === "guest" || !scopeOf(v).canWrite) throw new RecordingsError(403, "You can look at this graph but not propose people in it.");
  const { name } = body.parse(await req.json().catch(() => ({})));
  const r = await proposeSpeaker(v, id, name);
  if (!r) throw new RecordingsError(404, "This recording doesn't exist, or you can't see it.");
  return Response.json(r, { status: 201 });
});
