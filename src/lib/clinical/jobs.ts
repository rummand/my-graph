/**
 * The clinical job kinds on the durable queue (server-only): "clinical.transcribe" (subject: the audio source) and
 * "clinical.draft" (subject: the transcript source; the session is in the payload). Each runs as the clinician who started it, in the practice graph, and
 * re-checks their access and the client's consent when it starts — a consent withdrawn while the job waited stops it.
 * The session row mirrors the state ("running" / "done" / "failed" with a reason key) for the session page.
 */
import { z } from "zod";
import { viewerFor } from "@/lib/auth/viewer-for";
import { PermanentJobError, type JobProgress } from "@/lib/jobs/policy";
import type { JobRow } from "@/lib/jobs/queue";
import { isMuxDown } from "@/lib/mux";
import { ClinicalError } from "./access";
import { errKey, runDraftJob, runTranscriptionJob, setWork } from "./generate";

type Ctx = { progress: (p: JobProgress) => Promise<void> };

const transcribePayload = z.object({ sessionId: z.string().uuid(), audioSourceId: z.string().uuid(), mode: z.enum(["record", "upload", "dictate"]) });
const draftPayload = z.object({ sessionId: z.string().uuid() });

async function clinician(job: JobRow) {
  const v = await viewerFor(job.userId, job.graphId);
  if (!v) throw new PermanentJobError("The clinician who started this is no longer a member of this practice.");
  return v;
}

/** Run, mirror the outcome on the session, and tell the queue whether trying again can help. */
async function guarded(sessionId: string, job: JobRow, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (e) {
    const key = errKey(e);
    const last = job.attempts >= job.maxAttempts;
    // mux down: the queue tries again later; the session says so meanwhile. Consent or access: never again.
    await setWork(sessionId, "failed", key).catch(() => {});
    if (e instanceof ClinicalError) throw new PermanentJobError(key);
    if (isMuxDown(e) && !last) throw new Error("The local transcription model (mux) didn't answer. It will be tried again.");
    throw e;
  }
}

export async function clinicalTranscribeJob(job: JobRow, ctx: Ctx): Promise<void> {
  const p = transcribePayload.safeParse(job.payload);
  if (!p.success) throw new PermanentJobError("This transcription job is missing its session.");
  const v = await clinician(job);
  await guarded(p.data.sessionId, job, () => runTranscriptionJob(v, p.data.sessionId, p.data.audioSourceId, p.data.mode, ctx.progress));
}

export async function clinicalDraftJob(job: JobRow, ctx: Ctx): Promise<void> {
  const p = draftPayload.safeParse(job.payload);
  if (!p.success) throw new PermanentJobError("This drafting job is missing its session.");
  const v = await clinician(job);
  await guarded(p.data.sessionId, job, () => runDraftJob(v, p.data.sessionId, ctx.progress));
}
