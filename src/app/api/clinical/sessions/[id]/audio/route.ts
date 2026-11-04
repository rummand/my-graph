import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { sources } from "@/db/schema";
import { ClinicalError, loadSession, saveAudio, startTranscription } from "@/lib/clinical";
import { parseParam, route, uuid } from "@/lib/clinical/http";
import { readStored } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };
const idOf = async (ctx: Ctx) => parseParam((await ctx.params).id, uuid);
const mode = z.enum(["record", "upload", "dictate"]);

/**
 * POST multipart { file, mode: record | upload | dictate }: keep the audio (sensitive, private) and transcribe it on
 * the local models. Recording needs the recording consent, transcribing the transcription consent; a dictation needs
 * the notes consent. Answers 202: transcription and drafting continue in the background.
 */
export const POST = route<Ctx>(async (req, v, ctx) => {
  const id = await idOf(ctx);
  let form: FormData;
  try { form = await req.formData(); } catch { throw new ClinicalError(400, "clinical.err.badUpload"); }
  const file = form.get("file");
  if (!(file instanceof File)) throw new ClinicalError(400, "clinical.err.emptyAudio");
  const m = mode.safeParse(form.get("mode") ?? "upload");
  if (!m.success) throw new ClinicalError(400, "clinical.err.badUpload");
  const saved = await saveAudio(v, id, file, m.data);
  await startTranscription(v, id, saved.sourceId, m.data);
  return NextResponse.json({ sourceId: saved.sourceId }, { status: 202 });
});

/** GET: play the session's recording (the clinician, or a colleague the record is shared with). */
export const GET = route<Ctx>(async (_req, v, ctx) => {
  const { session } = await loadSession(v, await idOf(ctx));
  if (!session.audioSourceId) throw new ClinicalError(404, "clinical.err.notFound");
  const [src] = await db.select({ key: sources.storageKey, mime: sources.mime }).from(sources).where(eq(sources.id, session.audioSourceId));
  if (!src?.key) throw new ClinicalError(404, "clinical.err.notFound");
  const buf = await readStored(src.key);
  return new Response(new Uint8Array(buf), { headers: { "content-type": src.mime ?? "audio/webm", "cache-control": "private, no-store", "content-length": String(buf.length) } });
});
