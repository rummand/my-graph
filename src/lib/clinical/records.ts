/**
 * Clients, consents, sharing and sessions (server). Writes check the client's consent first (`gate`), and every
 * consent change is kept in `clinical_consent_events` and the audit log.
 */
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { db } from "@/db";
import { clinicalConsentEvents, clinicalConsents, clinicalSessions, shares, sources } from "@/db/schema";
import { audit, type Viewer } from "@/lib/auth";
import * as gbrain from "@/lib/gbrain";
import { sourceReadSql } from "@/lib/gbrain/access";
import { roleRelation } from "@/lib/meta/roles";
import { putFile, sha256Hex } from "@/lib/storage";
import {
  ClinicalError, accessibleClients, asConsentRow, colleagues, consentRows, gate, loadClient, names, requireClinical, type ClientRecord,
} from "./access";
import { CLIENT_KIND, MEETING_KIND, PURPOSES, checkConsent, consentInForce, type Discipline, type Purpose } from "./pure";

const me = (v: Viewer): gbrain.ProvenanceInput => ({ activity: "manual_edit", agentType: "user", agentId: v.id });

/* ── Clients ─────────────────────────────────────────────────────────────────────────────────────────── */

export async function listClients(v: Viewer): Promise<ClientRecord[]> {
  const ds = await requireClinical(v);
  return accessibleClients(v, ds);
}

/** A new client (psychology) or patient (medical): a private, sensitive person node owned by the clinician. */
export async function createClient(v: Viewer, input: { name: string; discipline: Discipline; reason?: string | null }): Promise<{ id: string }> {
  const ds = await requireClinical(v);
  if (!ds.includes(input.discipline)) throw new ClinicalError(404, "clinical.err.notFound");
  const id = randomUUID();
  await gbrain.upsertNode(v, {
    id, type: "person", kind: CLIENT_KIND[input.discipline], label: input.name, visibility: "private", sensitive: true,
    props: { clinical: true, ...(input.reason ? { referral_reason: input.reason } : {}), started_on: new Date().toISOString().slice(0, 10) },
  }, me(v));
  // Client and patient are roles, held with the clinician (src/lib/meta/roles.ts). The record kind stays what clinical
  // access is decided on; the role edge is private like the record, and never blocks creating it.
  if (v.personNodeId) {
    await gbrain.addEdge(v, { fromId: id, toId: v.personNodeId, relation: roleRelation(CLIENT_KIND[input.discipline]), status: "confirmed", visibility: "private" }, { ...me(v), confidence: 1, note: "Started with the clinician" })
      .catch((e) => console.warn("[clinical] could not record the client role", (e as Error).message));
  }
  void audit(v, "clinical.client.create", { type: "node", id }, { discipline: input.discipline }).catch(() => {});
  return { id };
}

/* ── Consent ─────────────────────────────────────────────────────────────────────────────────────────── */

export type ConsentInput = {
  purposes: Purpose[]; sharedWith: string[]; signedAt: Date; reviewAt: Date | null; documentSourceId: string | null; note: string | null;
};

async function checkConsentInput(v: Viewer, input: Partial<ConsentInput>): Promise<void> {
  if (input.purposes && input.purposes.some((p) => !PURPOSES.includes(p))) throw new ClinicalError(400, "clinical.err.badPurpose");
  if (input.signedAt && input.reviewAt && input.reviewAt <= input.signedAt) throw new ClinicalError(400, "clinical.err.reviewBeforeSigned");
  if (input.sharedWith?.length) {
    const ok = new Set((await colleagues(v)).map((c) => c.id));
    if (input.sharedWith.some((id) => !ok.has(id))) throw new ClinicalError(400, "clinical.err.notColleague");
  }
  if (input.documentSourceId) {
    const ctx = await gbrain.accessContext(v);
    const [doc] = await db.select({ id: sources.id }).from(sources)
      .where(and(eq(sources.id, input.documentSourceId), eq(sources.graphId, v.graphId), sourceReadSql(ctx, "sources")));
    if (!doc) throw new ClinicalError(400, "clinical.err.noDocument");
  }
}

const snap = (c: typeof clinicalConsents.$inferSelect) => ({
  purposes: c.purposes, sharedWith: c.sharedWith, signedAt: c.signedAt.toISOString(), reviewAt: c.reviewAt?.toISOString() ?? null,
  withdrawnAt: c.withdrawnAt?.toISOString() ?? null, withdrawnNote: c.withdrawnNote, documentSourceId: c.documentSourceId, note: c.note,
});

export async function addConsent(v: Viewer, clientId: string, input: ConsentInput): Promise<{ id: string }> {
  const rec = await loadClient(v, clientId, "write");
  await checkConsentInput(v, input);
  const row = await db.transaction(async (tx) => {
    const [c] = await tx.insert(clinicalConsents).values({
      graphId: v.graphId, householdId: v.graphHouseholdId, clientNodeId: rec.id, clinicianId: v.id,
      documentSourceId: input.documentSourceId, purposes: [...new Set(input.purposes)], sharedWith: [...new Set(input.sharedWith)],
      signedAt: input.signedAt, reviewAt: input.reviewAt, note: input.note,
    }).returning();
    await tx.insert(clinicalConsentEvents).values({ consentId: c.id, graphId: v.graphId, clientNodeId: rec.id, actorId: v.id, action: "created", before: null, after: snap(c) });
    return c;
  });
  void audit(v, "clinical.consent.create", { type: "consent", id: row.id }, { client: rec.id, purposes: row.purposes }).catch(() => {});
  await syncShares(v, rec.id);
  return { id: row.id };
}

async function loadConsent(v: Viewer, consentId: string) {
  const [c] = await db.select().from(clinicalConsents).where(and(eq(clinicalConsents.id, consentId), eq(clinicalConsents.graphId, v.graphId)));
  if (!c) throw new ClinicalError(404, "clinical.err.notFound");
  await loadClient(v, c.clientNodeId, "write");
  return c;
}

export async function updateConsent(v: Viewer, consentId: string, patch: Partial<ConsentInput>): Promise<void> {
  const c = await loadConsent(v, consentId);
  if (c.withdrawnAt) throw new ClinicalError(409, "clinical.err.consentWithdrawn");
  await checkConsentInput(v, { ...patch, signedAt: patch.signedAt ?? c.signedAt, reviewAt: patch.reviewAt === undefined ? c.reviewAt : patch.reviewAt });
  const set: Partial<typeof clinicalConsents.$inferInsert> = { updatedAt: new Date() };
  if (patch.purposes) set.purposes = [...new Set(patch.purposes)];
  if (patch.sharedWith) set.sharedWith = [...new Set(patch.sharedWith)];
  if (patch.signedAt) set.signedAt = patch.signedAt;
  if (patch.reviewAt !== undefined) set.reviewAt = patch.reviewAt;
  if (patch.documentSourceId !== undefined) set.documentSourceId = patch.documentSourceId;
  if (patch.note !== undefined) set.note = patch.note;
  await db.transaction(async (tx) => {
    const [u] = await tx.update(clinicalConsents).set(set).where(eq(clinicalConsents.id, c.id)).returning();
    await tx.insert(clinicalConsentEvents).values({ consentId: c.id, graphId: v.graphId, clientNodeId: c.clientNodeId, actorId: v.id, action: "changed", before: snap(c), after: snap(u) });
  });
  void audit(v, "clinical.consent.change", { type: "consent", id: c.id }, { client: c.clientNodeId }).catch(() => {});
  await syncShares(v, c.clientNodeId);
}

/** Withdrawal: recording stops, analysis is hidden, sharing ends. Kept in the history with the clinician's note. */
export async function withdrawConsent(v: Viewer, consentId: string, note: string | null): Promise<void> {
  const c = await loadConsent(v, consentId);
  if (c.withdrawnAt) return;
  await db.transaction(async (tx) => {
    const [u] = await tx.update(clinicalConsents).set({ withdrawnAt: new Date(), withdrawnNote: note, updatedAt: new Date() }).where(eq(clinicalConsents.id, c.id)).returning();
    await tx.insert(clinicalConsentEvents).values({ consentId: c.id, graphId: v.graphId, clientNodeId: c.clientNodeId, actorId: v.id, action: "withdrawn", before: snap(c), after: snap(u) });
  });
  void audit(v, "clinical.consent.withdraw", { type: "consent", id: c.id }, { client: c.clientNodeId }).catch(() => {});
  await syncShares(v, c.clientNodeId);
}

export type ConsentEventView = { id: string; action: string; actorName: string | null; at: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null };

export async function consentHistory(v: Viewer, clientId: string): Promise<ConsentEventView[]> {
  const rec = await loadClient(v, clientId);
  const rows = await db.select().from(clinicalConsentEvents).where(and(eq(clinicalConsentEvents.graphId, v.graphId), eq(clinicalConsentEvents.clientNodeId, rec.id))).orderBy(desc(clinicalConsentEvents.at)).limit(200);
  const who = await names([...new Set(rows.map((r) => r.actorId).filter((x): x is string => !!x))]);
  return rows.map((r) => ({ id: r.id, action: r.action, actorName: r.actorId ? who.get(r.actorId) ?? null : null, at: r.at.toISOString(), before: r.before, after: r.after }));
}

/* ── Sharing with named colleagues ───────────────────────────────────────────────────────────────────── */

async function recordNodeIds(graphId: string, clientId: string): Promise<string[]> {
  const sess = await db.select({ nodeId: clinicalSessions.nodeId }).from(clinicalSessions).where(and(eq(clinicalSessions.graphId, graphId), eq(clinicalSessions.clientNodeId, clientId)));
  return [clientId, ...sess.map((s) => s.nodeId).filter((x): x is string => !!x)];
}

/** Who the client node is shared with now. */
export async function sharedWith(v: Viewer, clientId: string): Promise<{ id: string; name: string }[]> {
  const rows = await db.select({ userId: shares.userId }).from(shares).where(eq(shares.nodeId, clientId));
  const ids = [...new Set(rows.map((r) => r.userId))].filter((id) => id !== v.id);
  const who = await names(ids);
  return ids.map((id) => ({ id, name: who.get(id) ?? "?" }));
}

/** Share the record (client and session nodes, read only) with a colleague the consent names. */
export async function shareClient(v: Viewer, clientId: string, userId: string): Promise<void> {
  const rec = await loadClient(v, clientId, "write");
  gate(rec, "share", { colleagueId: userId });
  const ids = await recordNodeIds(v.graphId, rec.id);
  const have = new Set((await db.select({ nodeId: shares.nodeId }).from(shares).where(and(eq(shares.userId, userId), inArray(shares.nodeId, ids)))).map((s) => s.nodeId));
  const add = ids.filter((id) => !have.has(id));
  if (add.length) await db.insert(shares).values(add.map((nodeId) => ({ nodeId, userId, canEdit: false })));
  void audit(v, "clinical.share", { type: "node", id: rec.id }, { with: userId }).catch(() => {});
}

export async function unshareClient(v: Viewer, clientId: string, userId: string): Promise<void> {
  const rec = await loadClient(v, clientId, "write");
  const ids = await recordNodeIds(v.graphId, rec.id);
  await db.delete(shares).where(and(eq(shares.userId, userId), inArray(shares.nodeId, ids)));
  void audit(v, "clinical.unshare", { type: "node", id: rec.id }, { with: userId }).catch(() => {});
}

/** After a consent change: remove shares the consent no longer allows; give new session nodes the existing shares. */
export async function syncShares(v: Viewer, clientId: string): Promise<void> {
  const rows = (await consentRows(v.graphId, [clientId])).get(clientId)?.map(asConsentRow) ?? [];
  const ids = await recordNodeIds(v.graphId, clientId);
  const current = await db.select().from(shares).where(inArray(shares.nodeId, ids));
  const users = [...new Set(current.map((s) => s.userId))];
  const now = new Date();
  for (const u of users) {
    if (u === v.id) continue;
    if (!checkConsent(rows, "sharing", now, { colleagueId: u }).ok) {
      await db.delete(shares).where(and(eq(shares.userId, u), inArray(shares.nodeId, ids)));
      continue;
    }
    // Shared with the client: also every session.
    if (current.some((s) => s.userId === u && s.nodeId === clientId)) {
      const have = new Set(current.filter((s) => s.userId === u).map((s) => s.nodeId));
      const add = ids.filter((id) => !have.has(id));
      if (add.length) await db.insert(shares).values(add.map((nodeId) => ({ nodeId, userId: u, canEdit: false })));
    }
  }
}

/* ── Sessions and consultations ──────────────────────────────────────────────────────────────────────── */

export type SessionRow = typeof clinicalSessions.$inferSelect;

export async function createSession(v: Viewer, clientId: string, input: { startsAt: Date; title?: string | null; language: "da" | "en" }): Promise<{ id: string }> {
  const rec = await loadClient(v, clientId, "write");
  const kind = MEETING_KIND[rec.discipline];
  const nodeId = randomUUID();
  const label = input.title?.trim() || `${kind === "session" ? "Session" : "Consultation"}: ${rec.label}, ${input.startsAt.toISOString().slice(0, 10)}`;
  await gbrain.upsertNode(v, { id: nodeId, type: "event", kind, label, startAt: input.startsAt, timePrecision: "minute", visibility: "private", sensitive: true, props: { clinical: true } }, me(v));
  await gbrain.addEdge(v, { fromId: rec.id, toId: nodeId, relation: "attended", status: "confirmed", visibility: "private" }, me(v)).catch((e) => console.error("[clinical] attended edge", e));
  const [s] = await db.insert(clinicalSessions).values({
    graphId: v.graphId, householdId: v.graphHouseholdId, clientNodeId: rec.id, clinicianId: v.id, nodeId, discipline: rec.discipline, kind,
    title: input.title?.trim() || null, startsAt: input.startsAt, language: input.language,
  }).returning({ id: clinicalSessions.id });
  await syncShares(v, rec.id);
  return { id: s.id };
}

/** A session the viewer may open, with its client's record (access checked on the client). */
export async function loadSession(v: Viewer, id: string, need: "read" | "write" = "read"): Promise<{ session: SessionRow; client: ClientRecord }> {
  await requireClinical(v);
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ClinicalError(404, "clinical.err.notFound");
  const [s] = await db.select().from(clinicalSessions).where(and(eq(clinicalSessions.id, id), eq(clinicalSessions.graphId, v.graphId)));
  if (!s) throw new ClinicalError(404, "clinical.err.notFound");
  const client = await loadClient(v, s.clientNodeId, need);
  return { session: s, client };
}

export async function listSessions(v: Viewer, opts: { clientId?: string; from?: Date; to?: Date; mine?: boolean; limit?: number }): Promise<SessionRow[]> {
  const conds = [eq(clinicalSessions.graphId, v.graphId)];
  if (opts.clientId) conds.push(eq(clinicalSessions.clientNodeId, opts.clientId));
  if (opts.from) conds.push(gte(clinicalSessions.startsAt, opts.from));
  if (opts.to) conds.push(lt(clinicalSessions.startsAt, opts.to));
  if (opts.mine) conds.push(eq(clinicalSessions.clinicianId, v.id));
  return db.select().from(clinicalSessions).where(and(...conds)).orderBy(opts.clientId ? desc(clinicalSessions.startsAt) : asc(clinicalSessions.startsAt)).limit(opts.limit ?? 200);
}

const AUDIO = /^(audio\/|video\/webm|video\/mp4|application\/octet-stream)/;
export const MAX_AUDIO_BYTES = 200 * 1024 * 1024;

/**
 * Keep a recording (browser or upload) or a dictation as a sensitive, private source in the practice graph. Recording
 * and upload need the recording consent; a dictation (the clinician's own voice) needs the notes consent.
 */
export async function saveAudio(v: Viewer, sessionId: string, file: File, mode: "record" | "upload" | "dictate"): Promise<{ sourceId: string; session: SessionRow; client: ClientRecord }> {
  const { session, client } = await loadSession(v, sessionId, "write");
  gate(client, mode === "dictate" ? "dictate" : mode === "record" ? "record" : "upload_audio");
  if (!file.size) throw new ClinicalError(400, "clinical.err.emptyAudio");
  if (file.size > MAX_AUDIO_BYTES) throw new ClinicalError(413, "clinical.err.audioTooBig");
  const mime = file.type || "application/octet-stream";
  if (!AUDIO.test(mime)) throw new ClinicalError(415, "clinical.err.notAudio");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const stored = await putFile(bytes);
  const title = `${mode === "dictate" ? "Dictation" : "Recording"}: ${client.label}, ${session.startsAt.toISOString().slice(0, 10)}`;
  const [src] = await db.insert(sources).values({
    householdId: v.graphHouseholdId, graphId: v.graphId, ownerId: v.id, kind: "upload", title, mime, storageKey: stored.storageKey,
    sha256: sha256Hex(bytes), size: stored.size, status: "ready", visibility: "private", sensitive: true, documentDate: session.startsAt,
    meta: { clinical: true, sessionId: session.id, mode, originalName: file.name || null },
  }).returning({ id: sources.id });
  if (mode !== "dictate") {
    await db.update(clinicalSessions).set({ audioSourceId: src.id, status: session.status === "planned" ? "recorded" : session.status, updatedAt: new Date() }).where(eq(clinicalSessions.id, session.id));
  }
  void audit(v, "clinical.audio", { type: "source", id: src.id }, { session: session.id, mode }).catch(() => {});
  return { sourceId: src.id, session, client };
}

/** The transcript text of a session, for the clinician and colleagues the record is shared with. */
export async function transcriptOf(session: SessionRow): Promise<{ text: string; segments: { start: number; end: number; text: string }[] } | null> {
  if (!session.transcriptSourceId) return null;
  const [s] = await db.select({ text: sources.textContent, meta: sources.meta }).from(sources).where(eq(sources.id, session.transcriptSourceId));
  if (!s) return null;
  const segs = Array.isArray(s.meta?.segments) ? (s.meta.segments as { start: number; end: number; text: string }[]) : [];
  return { text: s.text ?? "", segments: segs };
}

/** Store (or replace) the transcript as its own sensitive source. */
export async function saveTranscript(v: Viewer, session: SessionRow, clientLabel: string, text: string, segments: { start: number; end: number; text: string }[], from: "transcription" | "typed"): Promise<string> {
  const title = `Transcript: ${clientLabel}, ${session.startsAt.toISOString().slice(0, 10)}`;
  const meta = { clinical: true, sessionId: session.id, from, segments: segments.slice(0, 5000), audioSourceId: session.audioSourceId };
  if (session.transcriptSourceId) {
    await db.update(sources).set({ textContent: text, meta, status: "ready" }).where(eq(sources.id, session.transcriptSourceId));
    return session.transcriptSourceId;
  }
  const [src] = await db.insert(sources).values({
    householdId: v.graphHouseholdId, graphId: v.graphId, ownerId: v.id, kind: "manual", title, mime: "text/plain", textContent: text,
    status: "ready", visibility: "private", sensitive: true, documentDate: session.startsAt, meta,
  }).returning({ id: sources.id });
  await db.update(clinicalSessions).set({ transcriptSourceId: src.id, status: "transcribed", updatedAt: new Date() }).where(eq(clinicalSessions.id, session.id));
  return src.id;
}

export function inForceCount(rec: ClientRecord): number {
  return rec.consents.filter((c) => consentInForce(c)).length;
}
