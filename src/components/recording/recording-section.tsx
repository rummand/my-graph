/** The player on a recording's library page (server component): loads the time line and hands it to the player. */
import { getRecording } from "@/lib/connectors/record/recordings";
import type { Viewer } from "@/lib/auth";
import { RecordingPlayer } from "./player";

export async function RecordingSection({ viewer, sourceId }: { viewer: Viewer; sourceId: string }) {
  const r = await getRecording(viewer, sourceId);
  if (!r) return null;
  return <RecordingPlayer recording={r} layout="embedded" />;
}
