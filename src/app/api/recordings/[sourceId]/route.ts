import { getRecording } from "@/lib/connectors/record/recordings";
import { RecordingsError, recordingsRoute, sourceIdOf } from "@/lib/connectors/record/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET: one recording for the player: its time line (words, lines), speakers with their person, and whether it has sound. */
export const GET = recordingsRoute(async (_req, v, { params }: { params: Promise<{ sourceId: string }> }) => {
  const r = await getRecording(v, await sourceIdOf(params));
  if (!r) throw new RecordingsError(404, "This recording doesn't exist, or you can't see it.");
  return { recording: r };
});
