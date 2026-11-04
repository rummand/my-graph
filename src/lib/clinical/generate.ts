/**
 * Background work on a session, on the durable job queue (src/lib/jobs; kinds "clinical.transcribe" about the audio
 * source and "clinical.draft" about the transcript source, status mirrored on the session row): transcribe the recording through mux on the sensitive route
 * (local models, no fallback) in the session's language, surface risk mentions at once, then draft the note and, when
 * the consent allows analysis, themes, hypotheses and codes (checked against the bundled ICD-10 / ICPC-2 lists).
 * Everything drafted is a proposal for the clinician. A restart never loses the work: the queue picks it up again.
 */
import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "@/db";
import { clinicalItems, clinicalSessions, sources } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { enqueueJob } from "@/lib/jobs/queue";
import type { JobProgress } from "@/lib/jobs/policy";
import { completeJson, isMuxDown, transcribe } from "@/lib/mux";
import { readStored } from "@/lib/storage";
import { ClinicalError, allowed, gate, loadClient, type ClientRecord } from "./access";
import { checkCodes } from "./codes";
import { codeTables } from "./codes-data";
import { insertItems, replaceUnedited, type NewItem } from "./items";
import { analysisPrompt, notesPrompt, type Lang } from "./prompts";
import {
  NOTE_SECTIONS, analysisDraftSchema, dueFrom, extractRiskFlags, notesDraftSchema, parseCodeSuggestions, quoteFound, verifiedQuotes,
  type RiskCategory,
} from "./pure";
import { loadSession, saveTranscript, transcriptOf, type SessionRow } from "./records";

const meta = (v: Viewer, agent: string) => ({ userId: v.id, agent, sensitive: true, graphId: v.graphId });

export async function setWork(id: string, work: "idle" | "queued" | "running" | "done" | "failed", error: string | null = null, extra: Partial<typeof clinicalSessions.$inferInsert> = {}) {
  await db.update(clinicalSessions).set({ work, workError: error, updatedAt: new Date(), ...extra }).where(eq(clinicalSessions.id, id));
}

export const errKey = (e: unknown) => (isMuxDown(e) ? "mux_down" : e instanceof ClinicalError ? e.key : "failed");

type Progress = (p: JobProgress) => Promise<void>;
const noProgress: Progress = async () => {};

/**
 * Queue transcribing a saved recording or dictation. Checks consent now (so the person sees a block at once); the job
 * checks again when it runs. A recording needs the transcription consent; a dictation, the notes consent.
 */
export async function startTranscription(v: Viewer, sessionId: string, audioSourceId: string, mode: "record" | "upload" | "dictate"): Promise<void> {
  const { session, client } = await loadSession(v, sessionId, "write");
  gate(client, mode === "dictate" ? "dictate" : "transcribe");
  await enqueueJob({
    graphId: v.graphId, userId: v.id, kind: "clinical.transcribe", subjectId: audioSourceId,
    payload: { sessionId: session.id, audioSourceId, mode }, priority: 5, heavy: true, maxAttempts: 3,
  });
  await setWork(session.id, "running");
}

/** The job: transcribe, then draft (in the same job, so the note follows the words without waiting in line again). */
export async function runTranscriptionJob(v: Viewer, sessionId: string, audioSourceId: string, mode: "record" | "upload" | "dictate", progress: Progress = noProgress): Promise<void> {
  const { session, client } = await loadSession(v, sessionId, "write");
  gate(client, mode === "dictate" ? "dictate" : "transcribe");
  await setWork(session.id, "running");
  await runTranscription(v, session, client, audioSourceId, mode, progress);
}

async function runTranscription(v: Viewer, session: SessionRow, client: ClientRecord, audioSourceId: string, mode: "record" | "upload" | "dictate", progress: Progress) {
  const [src] = await db.select().from(sources).where(and(eq(sources.id, audioSourceId), eq(sources.graphId, v.graphId), eq(sources.ownerId, v.id)));
  if (!src?.storageKey) throw new ClinicalError(404, "clinical.err.notFound");
  await progress({ step: "transcribing", label: "Transcribing the recording" });
  const bytes = await readStored(src.storageKey);
  const ext = (src.mime ?? "").includes("mp4") ? "m4a" : (src.mime ?? "").includes("ogg") ? "ogg" : (src.mime ?? "").includes("mpeg") ? "mp3" : (src.mime ?? "").includes("wav") ? "wav" : "webm";
  const language = session.language === "en" ? "en" : "da";
  const out = await transcribe(new Blob([new Uint8Array(bytes)], { type: src.mime ?? "audio/webm" }), `audio.${ext}`, meta(v, "clinical-transcribe"), { language });
  await db.update(sources).set({ textContent: out.text, meta: { ...(src.meta ?? {}), segments: out.segments.slice(0, 5000) } }).where(eq(sources.id, src.id));
  if (mode === "dictate") {
    await progress({ step: "note", label: "Adding the dictation to the note" });
    await addDictation(v, session, client, out.text);
    await setWork(session.id, "done");
    return;
  }
  // A fresh row: saveTranscript links the transcript to the session.
  const [fresh] = await db.select().from(clinicalSessions).where(eq(clinicalSessions.id, session.id));
  const existing = fresh?.transcriptSourceId ? await transcriptOf(fresh) : null;
  const text = existing?.text?.trim() ? `${existing.text.trim()}\n\n${out.text}` : out.text;
  const segments = [...(existing?.segments ?? []), ...out.segments];
  await saveTranscript(v, fresh ?? session, client.label, text, segments, "transcription");
  await draftNow(v, session.id, progress);
}

/** The clinician's dictation becomes (or is added to) the session's draft note. */
async function addDictation(v: Viewer, session: SessionRow, client: ClientRecord, text: string) {
  if (!text.trim()) return;
  const [note] = await db.select().from(clinicalItems).where(and(eq(clinicalItems.sessionId, session.id), eq(clinicalItems.kind, "note"), eq(clinicalItems.status, "proposed"))).limit(1);
  let sections: Record<string, string> = {};
  try {
    const d = await completeJson({
      route: "smart", maxTokens: 3000, meta: meta(v, "clinical-dictation"),
      messages: notesPrompt({ discipline: client.discipline, lang: (session.language === "en" ? "en" : "da") as Lang, transcript: "", dictation: text, clientLabel: client.label }),
      parse: (x) => notesDraftSchema.parse(x),
    });
    sections = Object.fromEntries(NOTE_SECTIONS[client.discipline].map((k) => [k, String(d.note[k] ?? "").trim()]));
  } catch (e) {
    if (!isMuxDown(e)) console.error("[clinical] dictation structuring", e);
  }
  const hasSections = Object.values(sections).some(Boolean);
  if (note) {
    const c = note.content as { sections?: Record<string, string>; extra?: string };
    const merged = { ...(c.sections ?? {}) };
    if (hasSections) for (const [k, val] of Object.entries(sections)) if (val) merged[k] = merged[k]?.trim() ? `${merged[k].trim()}\n${val}` : val;
    const extra = hasSections ? c.extra ?? "" : [c.extra?.trim(), text.trim()].filter(Boolean).join("\n\n");
    const [u] = await db.update(clinicalItems).set({ content: { ...c, sections: merged, extra }, version: note.version + 1, updatedAt: new Date() }).where(eq(clinicalItems.id, note.id)).returning();
    const { clinicalItemRevisions } = await import("@/db/schema");
    await db.insert(clinicalItemRevisions).values({ itemId: u.id, version: u.version, action: "dictated", status: u.status, content: u.content, actorKind: "person", actorId: v.id });
    return;
  }
  await insertItems(db, v, client.id, [{ kind: "note", status: "proposed", purpose: "notes", sessionId: session.id, content: { sections: hasSections ? sections : {}, extra: hasSections ? "" : text.trim() }, model: hasSections ? "mux" : null }], "person", "dictated");
}

/** A transcript typed or pasted by the clinician (e.g. when transcription is not available); drafting is queued. */
export async function typedTranscript(v: Viewer, sessionId: string, text: string): Promise<void> {
  const { session, client } = await loadSession(v, sessionId, "write");
  gate(client, "draft_note");
  const transcriptId = await saveTranscript(v, session, client.label, text, [], "typed");
  await queueDraft(v, session.id, transcriptId);
}

/** Draft again on request. */
export async function startDraft(v: Viewer, sessionId: string): Promise<void> {
  const { session, client } = await loadSession(v, sessionId, "write");
  gate(client, "draft_note");
  if (!session.transcriptSourceId) throw new ClinicalError(409, "clinical.err.noTranscript");
  await queueDraft(v, session.id, session.transcriptSourceId);
}

/** Jobs are about a source (the queue's subject): drafting is keyed by the session's transcript, one waiting at a time. */
async function queueDraft(v: Viewer, sessionId: string, transcriptSourceId: string) {
  await enqueueJob({ graphId: v.graphId, userId: v.id, kind: "clinical.draft", subjectId: transcriptSourceId, payload: { sessionId }, priority: 5, maxAttempts: 3 });
  await setWork(sessionId, "running");
}

/** The job: draft the note (and analysis) for a session. */
export async function runDraftJob(v: Viewer, sessionId: string, progress: Progress = noProgress): Promise<void> {
  const { session, client } = await loadSession(v, sessionId, "write");
  gate(client, "draft_note");
  await setWork(session.id, "running");
  await draftNow(v, session.id, progress);
}

const RISK_CATS: RiskCategory[] = ["suicide", "self_harm", "harm_to_others"];

/** Risk flags first (no model needed), then the note and the analysis. */
async function draftNow(v: Viewer, sessionId: string, progress: Progress = noProgress): Promise<void> {
  const [session] = await db.select().from(clinicalSessions).where(eq(clinicalSessions.id, sessionId));
  if (!session) return;
  const client = await loadClient(v, session.clientNodeId, "write");
  const tr = await transcriptOf(session);
  if (!tr?.text.trim()) { await setWork(session.id, "done"); return; }
  if (!allowed(client, "draft_note")) { await setWork(session.id, "failed", "clinical.blocked.notes"); return; }
  const lang: Lang = session.language === "en" ? "en" : "da";
  const ev = (quote: string, timeSec?: number | null) => ({ quote, sourceId: session.transcriptSourceId, timeSec: timeSec ?? null });

  // 1. Risk mentions, at once.
  await progress({ step: "risk", label: "Looking for risk mentions" });
  const flags = extractRiskFlags(tr.text, tr.segments);
  await addRisks(v, session, client, flags.map((f) => ({ category: f.category, quote: f.quote, timeSec: f.timeSec ?? null })));

  // 2. The note (and, for doctors, medication and allergies), follow-ups and the model's own risk reading.
  let muxDown = false;
  await progress({ step: "note", label: "Drafting the note" });
  try {
    const d = await completeJson({
      route: "smart", maxTokens: 4000, meta: meta(v, "clinical-note"),
      messages: notesPrompt({ discipline: client.discipline, lang, transcript: tr.text, clientLabel: client.label }),
      parse: (x) => notesDraftSchema.parse(x),
    });
    const sections = Object.fromEntries(NOTE_SECTIONS[client.discipline].map((k) => [k, String(d.note[k] ?? "").trim().slice(0, 20_000)]));
    await addRisks(v, session, client, d.risks.filter((r) => RISK_CATS.includes(r.category as RiskCategory) && quoteFound(tr.text, r.quote))
      .map((r) => ({ category: r.category as RiskCategory, quote: r.quote.trim().slice(0, 400), timeSec: null })));
    await db.transaction(async (tx) => {
      const [edited] = await tx.select({ id: clinicalItems.id }).from(clinicalItems).where(and(eq(clinicalItems.sessionId, session.id), eq(clinicalItems.kind, "note"), eq(clinicalItems.status, "proposed"), ne(clinicalItems.version, 1))).limit(1);
      await replaceUnedited(tx, session.id, ["note", "followup", "medication", "allergy"]);
      const items: NewItem[] = [];
      if (!edited) items.push({ kind: "note", status: "proposed", purpose: "notes", sessionId: session.id, content: { sections, extra: "" }, evidence: [ev(tr.text.slice(0, 200))], model: "mux" });
      for (const f of d.followups) items.push({ kind: "followup", status: "proposed", purpose: "notes", sessionId: session.id, title: f.title, content: { title: f.title, dueAt: dueFrom(session.startsAt, f.dueInDays).toISOString(), why: f.why ?? "" }, model: "mux" });
      if (client.discipline === "medical") {
        for (const m of d.medications) {
          if (!m.quote || !quoteFound(tr.text, m.quote)) continue;
          items.push({ kind: "medication", status: "proposed", purpose: "notes", sessionId: session.id, title: m.name, content: { name: m.name, dose: m.dose ?? "", frequency: m.frequency ?? "", change: m.change ?? "" }, evidence: [ev(m.quote)], model: "mux" });
        }
        for (const a of d.allergies) {
          if (!a.quote || !quoteFound(tr.text, a.quote)) continue;
          items.push({ kind: "allergy", status: "proposed", purpose: "notes", sessionId: session.id, title: a.substance, content: { substance: a.substance, reaction: a.reaction ?? "" }, evidence: [ev(a.quote)], model: "mux" });
        }
      }
      await insertItems(tx, v, client.id, items, "assistant");
    });
  } catch (e) {
    if (!isMuxDown(e)) throw e;
    muxDown = true;
  }

  // 3. Analysis, only while the consent covers it.
  if (!muxDown && allowed(client, "themes")) {
    await progress({ step: "analysis", label: "Suggesting themes, hypotheses and codes" });
    try {
      const earlier = await earlierNotes(v, client.id, session.id);
      const a = await completeJson({
        route: "smart", maxTokens: 3000, meta: meta(v, "clinical-analysis"),
        messages: analysisPrompt({ discipline: client.discipline, lang, transcript: tr.text, earlier }),
        parse: (x) => analysisDraftSchema.parse(x),
      });
      const haystack = `${tr.text}\n\n${earlier}`;
      const items: NewItem[] = [];
      for (const th of a.themes) {
        const q = verifiedQuotes(haystack, th.quotes);
        if (q.length) items.push({ kind: "theme", status: "proposed", purpose: "analysis", sessionId: session.id, title: th.label, content: { label: th.label }, evidence: q.map((x) => ev(x)), model: "mux" });
      }
      for (const h of a.hypotheses) {
        const q = verifiedQuotes(haystack, h.evidence);
        if (!q.length) continue;
        const statement = /^(hypothesis|hypotese)\s*:/i.test(h.statement) ? h.statement : `${lang === "da" ? "Hypotese" : "Hypothesis"}: ${h.statement}`;
        items.push({ kind: "hypothesis", status: "proposed", purpose: "analysis", sessionId: session.id, title: statement.slice(0, 500), content: { statement, against: verifiedQuotes(haystack, h.against ?? []), confidence: h.confidence ?? null }, evidence: q.map((x) => ev(x)), model: "mux" });
      }
      // Codes: only ones that exist in the official lists, with the official title; odd wording is flagged.
      for (const c of checkCodes(parseCodeSuggestions(a.codes, haystack), await codeTables(), lang)) {
        items.push({
          kind: "code", status: "proposed", purpose: "analysis", sessionId: session.id, title: `${c.code} ${c.officialTitle}`.trim(),
          content: { system: c.system, code: c.code, label: c.officialTitle, officialTitle: c.officialTitle, suggestedAs: c.suggestedAs, mismatch: c.mismatch, confidence: c.confidence },
          evidence: c.evidence.map((x) => ev(x)), model: "mux",
        });
      }
      await db.transaction(async (tx) => {
        await replaceUnedited(tx, session.id, ["theme", "hypothesis", "code"]);
        await insertItems(tx, v, client.id, items, "assistant");
      });
    } catch (e) {
      if (!isMuxDown(e)) console.error("[clinical] analysis", e);
      else muxDown = true;
    }
  }
  await setWork(session.id, muxDown ? "failed" : "done", muxDown ? "mux_down" : null, muxDown ? {} : { status: session.status === "signed" ? "signed" : "drafted" });
}

async function addRisks(v: Viewer, session: SessionRow, client: ClientRecord, flags: { category: RiskCategory; quote: string; timeSec: number | null }[]) {
  if (!flags.length) return;
  const have = await db.select({ content: clinicalItems.content, evidence: clinicalItems.evidence }).from(clinicalItems).where(and(eq(clinicalItems.sessionId, session.id), eq(clinicalItems.kind, "risk")));
  const seen = new Set(have.map((h) => String(((h.evidence ?? [])[0] as { quote?: string } | undefined)?.quote ?? "").toLowerCase()));
  const fresh = flags.filter((f) => !seen.has(f.quote.toLowerCase()));
  await insertItems(db, v, client.id, fresh.map((f) => ({
    kind: "risk" as const, status: "open", purpose: "notes", sessionId: session.id, title: f.category,
    content: { category: f.category }, evidence: [{ quote: f.quote, sourceId: session.transcriptSourceId, timeSec: f.timeSec }],
  })), "assistant", "flagged");
}

async function earlierNotes(v: Viewer, clientId: string, sessionId: string): Promise<string> {
  const rows = await db.select({ content: clinicalItems.content, at: clinicalItems.createdAt }).from(clinicalItems)
    .where(and(eq(clinicalItems.graphId, v.graphId), eq(clinicalItems.clientNodeId, clientId), eq(clinicalItems.kind, "note"), inArray(clinicalItems.status, ["signed"]), ne(clinicalItems.sessionId, sessionId)))
    .limit(6);
  return rows.map((r) => `(${r.at.toISOString().slice(0, 10)})\n${String((r.content as { text?: string }).text ?? "")}`).join("\n\n");
}
