/**
 * What each kind of job does. Server-only. A handler runs as the job's person in the job's graph (viewerFor
 * re-checks that they still exist, may sign in and are a member), and throws to fail the attempt.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { sources } from "@/db/schema";
import { viewerFor } from "@/lib/auth/viewer-for";
import { scopeOf } from "@/lib/graphs/pure";
import { processSource, refreshSource } from "@/lib/ingest/pipeline";
import * as mux from "@/lib/mux";
import { PermanentJobError, type JobProgress } from "./policy";
import type { JobRow } from "./queue";

export type JobContext = { progress: (p: JobProgress) => Promise<void> };
type Handler = (job: JobRow, ctx: JobContext) => Promise<void>;

async function viewerOf(job: JobRow) {
  const v = await viewerFor(job.userId, job.graphId);
  if (!v) throw new PermanentJobError("The person who added it is no longer a member of this graph, so it wasn't read.");
  if (!scopeOf(v).canWrite) throw new PermanentJobError("The person who added it can no longer add to this graph, so it wasn't read.");
  return v;
}

async function sourceOf(job: JobRow) {
  if (!job.subjectId) throw new PermanentJobError("This job has nothing to read.");
  const [src] = await db.select({ id: sources.id, graphId: sources.graphId, status: sources.status, error: sources.error })
    .from(sources).where(eq(sources.id, job.subjectId)).limit(1);
  if (!src) throw new PermanentJobError("The file was deleted before it was read.");
  if (src.graphId !== job.graphId) throw new PermanentJobError("The file belongs to another graph.");
  return src;
}

/** Failures that reading again won't fix. */
const PERMANENT = /original file is missing|unknown type|no longer a member|not supported|isn't supported|is empty|too large/i;

const read: Handler = async (job, ctx) => {
  const v = await viewerOf(job);
  await sourceOf(job);
  await processSource(v, job.subjectId!, { fromFile: job.payload.fromFile === true, onProgress: ctx.progress });
  // processSource never throws; it writes the outcome on the source row.
  const after = await sourceOf(job);
  if (after.status === "failed") {
    const msg = after.error ?? "Reading it failed.";
    throw PERMANENT.test(msg) ? new PermanentJobError(msg) : new Error(msg);
  }
};

const rebuild: Handler = async (job, ctx) => {
  const v = await viewerOf(job);
  await sourceOf(job);
  await ctx.progress({ step: "refreshing" });
  let muxUp = false;
  try { muxUp = (await mux.muxHealth()).ok; } catch { muxUp = false; }
  const out = await refreshSource(v, job.subjectId!, muxUp);
  if (out.error) throw new Error(out.error);
};

export const HANDLERS: Record<string, Handler> = { "ingest.read": read, "ingest.rebuild": rebuild };
