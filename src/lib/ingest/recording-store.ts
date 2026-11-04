/**
 * The reading pipeline's access to a recording's time line (server-only): the lines as timed segments, and what the
 * meeting proposes (see recording.ts), bound to this source so proposeFromSource can fold it into its change set.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { recordingTimelines, type sources } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import type { ChangeInput } from "@/lib/changes";
import * as gbrain from "@/lib/gbrain";
import type { TextSegment } from "./chunk";
import type { KnownNode } from "./proposals";
import { dropGenericPeople, foldIntoMeeting, recordingInfo, recordingOps, recordingSegments, refineReceipts, type RecLine, type RecordingPlan } from "./recording";

export async function loadRecording(sourceId: string): Promise<{ lines: RecLine[]; segments: TextSegment[] } | null> {
  const [row] = await db.select({ lines: recordingTimelines.lines }).from(recordingTimelines).where(eq(recordingTimelines.sourceId, sourceId)).limit(1);
  if (!row) return null;
  const lines = (row.lines ?? []).map((l) => ({ a: l.a, b: l.b, speaker: l.speaker, text: l.text }));
  return { lines, segments: recordingSegments(lines) };
}

export type RecordingInput = {
  link: string | null;
  plan: (known: KnownNode[], existingEdges: ReadonlySet<string>, mint: () => string) => RecordingPlan;
  refine: (changes: ChangeInput[]) => void;
  /** Fold the reading's own copy of the meeting into it, and drop "Speaker 4" as a person. Returns people dropped. */
  tidy: (extracted: ChangeInput[], meetingEdgeKeys: string[]) => number;
};

/** What this recording source proposes, ready for proposeFromSource; null when it isn't a meeting we can read. */
export async function recordingPlanFor(v: Viewer, src: typeof sources.$inferSelect, docNodeId: string | null): Promise<RecordingInput | null> {
  const meta = src.meta ?? {};
  const info = recordingInfo(meta);
  if (!info) return null;
  const tl = await loadRecording(src.id);
  const lines = tl?.lines ?? [];
  const eventNodeId = typeof meta.eventNodeId === "string" ? meta.eventNodeId : crypto.randomUUID();
  const eventExists = !!(await gbrain.getNode(v, eventNodeId).catch(() => null));
  return {
    link: info.link,
    plan: (known, existingEdges, mint) => recordingOps({
      info, title: src.title, sourceId: src.id, docNodeId, eventNodeId, eventExists, lines, known, existingEdges, visibility: src.visibility, mint,
    }),
    refine: (changes) => refineReceipts(changes, src.id, info, lines),
    tidy: (extracted, meetingEdgeKeys) => {
      foldIntoMeeting(extracted, { title: src.title, eventNodeId, edgeKeys: new Set(meetingEdgeKeys) });
      return dropGenericPeople(extracted);
    },
  };
}
