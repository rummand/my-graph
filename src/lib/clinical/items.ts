/**
 * Clinical items: drafted notes and letters, suggestions (codes, medications, allergies, labs, themes, hypotheses,
 * follow-ups), risk flags and measures. Drafts are proposals; only the clinician's sign-off delivers them, as a change
 * set they author, with every version kept in `clinical_item_revisions`.
 */
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { clinicalItemRevisions, clinicalItems, clinicalSessions, sources } from "@/db/schema";
import { audit, type Viewer } from "@/lib/auth";
import { deliverChangeSet, proposeChanges, type Receipt } from "@/lib/changes";
import { accessContext } from "@/lib/gbrain";
import { sourceReadSql } from "@/lib/gbrain/access";
import { completeJson, isMuxDown } from "@/lib/mux";
import { ClinicalError, accessibleClients, allowed, gate, loadClient, names, requireClinical, type ClientRecord } from "./access";
import { signOffOps } from "./ops";
import { labsPrompt, letterPrompt, summaryPrompt, type Lang } from "./prompts";
import {
  ANALYSIS_KINDS, INSTRUMENTS, NOTE_HEADINGS, nextStatus, noteContent, noteText, parseLabValues, quoteFound, rangeFlag, scoreMeasure,
  type Decision, type Instrument, type ItemKind, type LabValue, type LetterKind,
} from "./pure";

export type ItemRow = typeof clinicalItems.$inferSelect;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Exec = typeof db | Tx;

export type Evidence = { quote?: string; sourceId?: string | null; timeSec?: number | null };

export type ItemView = {
  id: string; kind: ItemKind; status: string; purpose: string; title: string | null; content: Record<string, unknown>; evidence: Evidence[];
  value: number | null; unit: string | null; refLow: number | null; refHigh: number | null; flag: "low" | "high" | "normal" | null;
  measuredAt: string | null; version: number; sessionId: string | null; clientId: string; changeSetId: string | null; artifactId: string | null;
  decidedByName: string | null; decidedAt: string | null; createdAt: string; updatedAt: string; model: string | null;
};

export function itemView(r: ItemRow, who: Map<string, string>): ItemView {
  return {
    id: r.id, kind: r.kind as ItemKind, status: r.status, purpose: r.purpose, title: r.title, content: r.content ?? {}, evidence: (r.evidence ?? []) as Evidence[],
    value: r.value, unit: r.unit, refLow: r.refLow, refHigh: r.refHigh, flag: r.value != null ? rangeFlag(r.value, r.refLow, r.refHigh) : null,
    measuredAt: r.measuredAt?.toISOString() ?? null, version: r.version, sessionId: r.sessionId, clientId: r.clientNodeId,
    changeSetId: r.changeSetId, artifactId: r.artifactId, decidedByName: r.decidedBy ? who.get(r.decidedBy) ?? null : null,
    decidedAt: r.decidedAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(), model: r.model,
  };
}

export async function views(rows: ItemRow[]): Promise<ItemView[]> {
  const who = await names([...new Set(rows.map((r) => r.decidedBy).filter((x): x is string => !!x))]);
  return rows.map((r) => itemView(r, who));
}

export type NewItem = Omit<typeof clinicalItems.$inferInsert, "id" | "graphId" | "householdId" | "clinicianId" | "clientNodeId"> & { kind: ItemKind };

/** Insert items with their first revision. `actor` "assistant" for drafts, "person" for the clinician's own entries. */
export async function insertItems(ex: Exec, v: Viewer, clientId: string, items: NewItem[], actor: "assistant" | "person", action = "drafted"): Promise<ItemRow[]> {
  if (!items.length) return [];
  const rows = await ex.insert(clinicalItems).values(items.map((i) => ({ ...i, graphId: v.graphId, householdId: v.graphHouseholdId, clinicianId: v.id, clientNodeId: clientId }))).returning();
  await ex.insert(clinicalItemRevisions).values(rows.map((r) => ({ itemId: r.id, version: r.version, action, status: r.status, content: r.content, actorKind: actor, actorId: actor === "person" ? v.id : null })));
  return rows;
}

async function revise(ex: Exec, v: Viewer | null, r: ItemRow, action: string): Promise<void> {
  await ex.insert(clinicalItemRevisions).values({ itemId: r.id, version: r.version, action, status: r.status, content: r.content, actorKind: v ? "person" : "assistant", actorId: v?.id ?? null });
}

/** Proposed drafts of these kinds for a session that nobody edited yet are replaced by a new draft. */
export async function replaceUnedited(ex: Exec, sessionId: string, kinds: ItemKind[]): Promise<void> {
  const old = await ex.select().from(clinicalItems).where(and(eq(clinicalItems.sessionId, sessionId), inArray(clinicalItems.kind, kinds), eq(clinicalItems.status, "proposed"), eq(clinicalItems.version, 1)));
  for (const r of old) {
    const [u] = await ex.update(clinicalItems).set({ status: "dismissed", version: r.version + 1, updatedAt: new Date() }).where(eq(clinicalItems.id, r.id)).returning();
    await revise(ex, null, u, "replaced");
  }
}

/* ── Reading ─────────────────────────────────────────────────────────────────────────────────────────── */

/** A client's items. Analysis (themes, hypotheses, codes, summaries) is hidden when its consent isn't in force. */
export async function listItems(v: Viewer, rec: ClientRecord, opts: { sessionId?: string; kinds?: ItemKind[] } = {}): Promise<ItemView[]> {
  const conds = [eq(clinicalItems.graphId, v.graphId), eq(clinicalItems.clientNodeId, rec.id)];
  if (opts.sessionId) conds.push(eq(clinicalItems.sessionId, opts.sessionId));
  if (opts.kinds?.length) conds.push(inArray(clinicalItems.kind, opts.kinds));
  let rows = await db.select().from(clinicalItems).where(and(...conds)).orderBy(desc(clinicalItems.createdAt)).limit(1000);
  if (!allowed(rec, "themes")) rows = rows.filter((r) => !ANALYSIS_KINDS.includes(r.kind as ItemKind));
  // Colleagues read what was signed or confirmed, and the risk flags; drafts stay with the clinician.
  if (rec.access !== "clinician") rows = rows.filter((r) => ["signed", "confirmed", "done", "open", "acknowledged"].includes(r.status));
  return views(rows);
}

export type RevisionView = { id: string; version: number; action: string; status: string; content: Record<string, unknown>; actorName: string | null; actorKind: string; at: string };

export async function itemHistory(v: Viewer, itemId: string): Promise<RevisionView[]> {
  const { item } = await loadItem(v, itemId, "read");
  const rows = await db.select().from(clinicalItemRevisions).where(eq(clinicalItemRevisions.itemId, item.id)).orderBy(desc(clinicalItemRevisions.version), desc(clinicalItemRevisions.at));
  const who = await names([...new Set(rows.map((r) => r.actorId).filter((x): x is string => !!x))]);
  return rows.map((r) => ({ id: r.id, version: r.version, action: r.action, status: r.status, content: r.content, actorKind: r.actorKind, actorName: r.actorId ? who.get(r.actorId) ?? null : null, at: r.at.toISOString() }));
}

async function loadItem(v: Viewer, id: string, need: "read" | "write"): Promise<{ item: ItemRow; client: ClientRecord }> {
  await requireClinical(v);
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ClinicalError(404, "clinical.err.notFound");
  const [item] = await db.select().from(clinicalItems).where(and(eq(clinicalItems.id, id), eq(clinicalItems.graphId, v.graphId)));
  if (!item) throw new ClinicalError(404, "clinical.err.notFound");
  const client = await loadClient(v, item.clientNodeId, need);
  if (ANALYSIS_KINDS.includes(item.kind as ItemKind) && !allowed(client, "themes")) throw new ClinicalError(404, "clinical.err.notFound");
  return { item, client };
}

/* ── Editing and deciding ────────────────────────────────────────────────────────────────────────────── */

/** The clinician edits a draft (a new version; the old one stays in the history). */
export async function editItem(v: Viewer, id: string, patch: { content?: Record<string, unknown>; title?: string | null; value?: number | null; unit?: string | null; measuredAt?: Date | null }, baseVersion?: number): Promise<ItemView> {
  const { item } = await loadItem(v, id, "write");
  if (item.status !== "proposed") throw new ClinicalError(409, "clinical.err.notDraft");
  if (baseVersion !== undefined && baseVersion !== item.version) throw new ClinicalError(409, "clinical.err.changedMeanwhile");
  const set: Partial<typeof clinicalItems.$inferInsert> = { version: item.version + 1, updatedAt: new Date() };
  if (patch.content) set.content = { ...item.content, ...patch.content };
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.value !== undefined) set.value = patch.value;
  if (patch.unit !== undefined) set.unit = patch.unit;
  if (patch.measuredAt !== undefined) set.measuredAt = patch.measuredAt;
  const u = await db.transaction(async (tx) => {
    const [row] = await tx.update(clinicalItems).set(set).where(and(eq(clinicalItems.id, item.id), eq(clinicalItems.version, item.version))).returning();
    if (!row) throw new ClinicalError(409, "clinical.err.changedMeanwhile");
    await revise(tx, v, row, "edited");
    return row;
  });
  return (await views([u]))[0];
}

const KIND_TITLE: Record<string, string> = {
  note: "Signed note", letter: "Signed letter", code: "Confirmed code", medication: "Confirmed medication", allergy: "Confirmed allergy",
  lab: "Confirmed lab value", measure: "Measure", followup: "Follow-up",
};

/**
 * Sign, confirm, dismiss, acknowledge, complete or reopen. Signing or confirming delivers the item into the practice
 * graph as a change set the clinician authors (nothing else ever applies a draft). A signed letter becomes a document
 * in Documents, in the practice's design set.
 */
export async function decide(v: Viewer, id: string, decision: Decision, opts: { content?: Record<string, unknown>; baseVersion?: number } = {}): Promise<ItemView> {
  let { item, client } = await loadItem(v, id, "write");
  if (opts.content && item.status === "proposed") {
    await editItem(v, id, { content: opts.content }, opts.baseVersion);
    ({ item, client } = await loadItem(v, id, "write"));
  } else if (opts.baseVersion !== undefined && opts.baseVersion !== item.version) {
    throw new ClinicalError(409, "clinical.err.changedMeanwhile");
  }
  const next = nextStatus(item.kind as ItemKind, item.status, decision);
  if (!next) throw new ClinicalError(409, "clinical.err.cantDecide");
  if ((next === "confirmed" || next === "signed") && ANALYSIS_KINDS.includes(item.kind as ItemKind)) gate(client, "codes");

  let changeSetId: string | null = null;
  let artifactId: string | null = item.artifactId;
  if (next === "signed" || next === "confirmed") {
    const [sess] = item.sessionId ? await db.select().from(clinicalSessions).where(eq(clinicalSessions.id, item.sessionId)) : [];
    const ev = ((item.evidence ?? []) as Evidence[])[0];
    const receipt: Receipt = { sourceId: ev?.sourceId ?? sess?.transcriptSourceId ?? undefined, quote: ev?.quote?.slice(0, 600) };
    if (!receipt.sourceId) delete receipt.sourceId;
    if (!receipt.quote) delete receipt.quote;
    const signedAt = new Date();
    if (item.kind === "note") {
      const parsed = noteContent.safeParse(item.content);
      const lang = sess?.language === "en" ? "en" : "da";
      const text = parsed.success ? noteText(client.discipline, parsed.data, NOTE_HEADINGS[lang]) : String(item.content.text ?? "");
      if (!text.trim()) throw new ClinicalError(400, "clinical.err.emptyNote");
      item = { ...item, content: { ...item.content, text } };
    }
    const ops = signOffOps({ ...item, status: next }, {
      clientNodeId: client.id, clientLabel: client.label, sessionNodeId: sess?.nodeId ?? null, discipline: client.discipline, receipt, signedBy: v.id, signedAt,
    });
    if (ops.length) {
      const set = await proposeChanges(v, { title: `${KIND_TITLE[item.kind] ?? "Clinical record"}: ${client.label}`, origin: "person", evidence: receipt, changes: ops });
      if (!set) throw new ClinicalError(403, "clinical.err.viewer");
      const res = await deliverChangeSet(v, set.id);
      if (!res.ok) throw new ClinicalError(409, "clinical.err.deliverFailed", { why: res.error ?? res.conflicts.join("; ") });
      changeSetId = set.id;
    }
    if (item.kind === "letter") artifactId = await letterDocument(v, item, client);
    if (item.kind === "note" && sess) await db.update(clinicalSessions).set({ status: "signed", updatedAt: new Date() }).where(eq(clinicalSessions.id, sess.id));
  }
  const u = await db.transaction(async (tx) => {
    const [row] = await tx.update(clinicalItems).set({
      status: next, version: item.version + 1, updatedAt: new Date(), decidedBy: v.id, decidedAt: new Date(), content: item.content,
      ...(changeSetId ? { changeSetId } : {}), artifactId,
    }).where(and(eq(clinicalItems.id, item.id), eq(clinicalItems.version, item.version))).returning();
    if (!row) throw new ClinicalError(409, "clinical.err.changedMeanwhile");
    await revise(tx, v, row, decision === "sign" ? "signed" : decision === "confirm" ? "confirmed" : decision);
    return row;
  });
  void audit(v, `clinical.item.${decision}`, { type: "clinical_item", id: item.id }, { kind: item.kind, client: client.id, changeSetId }).catch(() => {});
  return (await views([u]))[0];
}

/** A signed letter as a private document in Documents (the graph's default design set). */
async function letterDocument(v: Viewer, item: ItemRow, client: ClientRecord): Promise<string | null> {
  const { createArtifact, updateArtifact } = await import("@/lib/artifacts");
  const c = item.content as { subject?: string; text?: string; recipient?: string };
  const title = (c.subject?.trim() || item.title || `Letter: ${client.label}`).slice(0, 200);
  const paragraphs = String(c.text ?? "").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const a = await createArtifact(v, { kind: "brief", title, query: {}, blank: true });
  await updateArtifact(v, a.id, {
    content: {
      subtitle: c.recipient ? String(c.recipient).slice(0, 200) : "",
      sections: [{ id: "letter", title: "", blocks: paragraphs.slice(0, 60).map((text, i) => ({ id: `p${i + 1}`, type: "text", text: text.slice(0, 6000) })) }],
      citations: [],
    },
  });
  return a.id;
}

/* ── The clinician's own entries ─────────────────────────────────────────────────────────────────────── */

/** PHQ-9 / GAD-7 entered by the clinician: recorded and delivered at once (it is their own entry). */
export async function addMeasure(v: Viewer, clientId: string, input: { instrument: Instrument; answers: number[]; takenAt: Date; sessionId?: string | null }): Promise<ItemView> {
  const rec = await loadClient(v, clientId, "write");
  gate(rec, "measure");
  let scored: ReturnType<typeof scoreMeasure>;
  try { scored = scoreMeasure(input.instrument, input.answers); } catch { throw new ClinicalError(400, "clinical.err.badAnswers"); }
  const label = INSTRUMENTS[input.instrument].label;
  const [row] = await insertItems(db, v, rec.id, [{
    kind: "measure", status: "proposed", purpose: "notes", sessionId: input.sessionId ?? null, title: label,
    content: { instrument: input.instrument, label, answers: input.answers, band: scored.band }, value: scored.score, measuredAt: input.takenAt,
  }], "person", "entered");
  if (scored.riskItem) {
    await insertItems(db, v, rec.id, [{
      kind: "risk", status: "open", purpose: "notes", sessionId: input.sessionId ?? null, title: "PHQ-9 question 9",
      content: { category: "suicide", fromMeasure: true, answer: input.answers[8] }, evidence: [{ quote: `PHQ-9, question 9: ${input.answers[8]} / 3` }],
    }], "person", "flagged");
  }
  return decide(v, row.id, "confirm");
}

/** A follow-up the clinician adds themselves (confirmed at once). */
export async function addFollowup(v: Viewer, clientId: string, input: { title: string; dueAt: Date; sessionId?: string | null }): Promise<ItemView> {
  const rec = await loadClient(v, clientId, "write");
  gate(rec, "followups");
  const [row] = await insertItems(db, v, rec.id, [{ kind: "followup", status: "confirmed", purpose: "notes", sessionId: input.sessionId ?? null, title: input.title, content: { title: input.title, dueAt: input.dueAt.toISOString() }, decidedBy: v.id, decidedAt: new Date() }], "person", "entered");
  return (await views([row]))[0];
}

/** An empty note for the clinician to write themselves. */
export async function blankNote(v: Viewer, sessionId: string, clientId: string): Promise<ItemView> {
  const rec = await loadClient(v, clientId, "write");
  gate(rec, "draft_note");
  const [have] = await db.select().from(clinicalItems).where(and(eq(clinicalItems.sessionId, sessionId), eq(clinicalItems.kind, "note"), eq(clinicalItems.status, "proposed"))).limit(1);
  if (have) return (await views([have]))[0];
  const [row] = await insertItems(db, v, rec.id, [{ kind: "note", status: "proposed", purpose: "notes", sessionId, content: { sections: {}, extra: "" } }], "person", "started");
  return (await views([row]))[0];
}

/* ── Lab results ─────────────────────────────────────────────────────────────────────────────────────── */

const meta = (v: Viewer, agent: string) => ({ userId: v.id, agent, sensitive: true, graphId: v.graphId });

/** Read lab values from an uploaded result in the library: proposed, each with the line it was read from. */
export async function importLabs(v: Viewer, clientId: string, sourceId: string, sessionId?: string | null): Promise<{ added: number; usedModel: boolean }> {
  const rec = await loadClient(v, clientId, "write");
  gate(rec, "labs");
  const ctx = await accessContext(v);
  const [src] = await db.select({ id: sources.id, text: sources.textContent, status: sources.status, documentDate: sources.documentDate, createdAt: sources.createdAt })
    .from(sources).where(and(eq(sources.id, sourceId), eq(sources.graphId, v.graphId), sourceReadSql(ctx, "sources")));
  if (!src) throw new ClinicalError(404, "clinical.err.noDocument");
  if (!src.text?.trim()) throw new ClinicalError(409, src.status === "ready" ? "clinical.err.noText" : "clinical.err.stillReading");
  let values: LabValue[] = parseLabValues(src.text);
  let usedModel = false;
  if (!values.length) {
    try {
      const out = await completeJson({
        route: "smart", messages: labsPrompt(src.text), maxTokens: 3000, meta: meta(v, "clinical-labs"),
        parse: (x) => (Array.isArray((x as { values?: unknown })?.values) ? (x as { values: Record<string, unknown>[] }).values : []),
      });
      values = out.flatMap((r) => {
        const quote = typeof r.quote === "string" ? r.quote : "";
        const value = Number(r.value);
        if (!quote || !quoteFound(src.text!, quote) || !Number.isFinite(value) || typeof r.name !== "string") return [];
        const lo = r.refLow == null ? null : Number(r.refLow), hi = r.refHigh == null ? null : Number(r.refHigh);
        const refLow = Number.isFinite(lo) ? lo : null, refHigh = Number.isFinite(hi) ? hi : null;
        return [{ name: r.name.slice(0, 80), value, unit: typeof r.unit === "string" ? r.unit.slice(0, 30) : null, refLow, refHigh, flag: rangeFlag(value, refLow, refHigh), quote }];
      });
      usedModel = true;
    } catch (e) {
      if (!isMuxDown(e)) console.error("[clinical] lab extraction", e);
    }
  }
  const have = await db.select({ title: clinicalItems.title, value: clinicalItems.value }).from(clinicalItems)
    .where(and(eq(clinicalItems.clientNodeId, rec.id), eq(clinicalItems.kind, "lab"), sql`${clinicalItems.evidence} @> ${JSON.stringify([{ sourceId: src.id }])}::jsonb`));
  const seen = new Set(have.map((h) => `${h.title}:${h.value}`));
  const fresh = values.filter((x) => !seen.has(`${x.name}:${x.value}`));
  await insertItems(db, v, rec.id, fresh.map((x) => ({
    kind: "lab" as const, status: "proposed", purpose: "notes", sessionId: sessionId ?? null, title: x.name, content: { name: x.name },
    evidence: [{ quote: x.quote, sourceId: src.id }], value: x.value, unit: x.unit, refLow: x.refLow, refHigh: x.refHigh,
    measuredAt: src.documentDate ?? src.createdAt, model: usedModel ? "mux" : "line-reader",
  })), usedModel ? "assistant" : "person", "read");
  return { added: fresh.length, usedModel };
}

/* ── Record text for letters and summaries (signed and confirmed only) ───────────────────────────────── */

async function recordText(v: Viewer, rec: ClientRecord): Promise<string> {
  const rows = await db.select().from(clinicalItems).where(and(eq(clinicalItems.graphId, v.graphId), eq(clinicalItems.clientNodeId, rec.id), inArray(clinicalItems.status, ["signed", "confirmed"]))).orderBy(desc(clinicalItems.createdAt)).limit(300);
  const sess = await db.select({ id: clinicalSessions.id, at: clinicalSessions.startsAt }).from(clinicalSessions).where(eq(clinicalSessions.clientNodeId, rec.id));
  const when = new Map(sess.map((s) => [s.id, s.at.toISOString().slice(0, 10)]));
  const by = (k: string) => rows.filter((r) => r.kind === k);
  const parts: string[] = [];
  const notes = by("note").slice(0, 6).map((r) => `Note (${r.sessionId ? when.get(r.sessionId) ?? "" : r.createdAt.toISOString().slice(0, 10)}):\n${String((r.content as { text?: string }).text ?? "")}`);
  if (notes.length) parts.push(notes.join("\n\n"));
  const meds = by("medication").map((r) => `- ${(r.content as Record<string, string>).name ?? r.title} ${(r.content as Record<string, string>).dose ?? ""} ${(r.content as Record<string, string>).frequency ?? ""}`.trim());
  if (meds.length) parts.push(`Medication:\n${meds.join("\n")}`);
  const allergies = by("allergy").map((r) => `- ${(r.content as Record<string, string>).substance ?? r.title}${(r.content as Record<string, string>).reaction ? ` (${(r.content as Record<string, string>).reaction})` : ""}`);
  if (allergies.length) parts.push(`Allergies:\n${allergies.join("\n")}`);
  const codes = by("code").map((r) => `- ${(r.content as Record<string, string>).system} ${(r.content as Record<string, string>).code} ${(r.content as Record<string, string>).label ?? ""}`);
  if (codes.length) parts.push(`Diagnoses:\n${codes.join("\n")}`);
  const labs = by("lab").slice(0, 30).map((r) => `- ${r.title} ${r.value} ${r.unit ?? ""}${r.refLow != null || r.refHigh != null ? ` (ref ${r.refLow ?? ""}-${r.refHigh ?? ""})` : ""} ${r.measuredAt?.toISOString().slice(0, 10) ?? ""}`);
  if (labs.length) parts.push(`Lab values:\n${labs.join("\n")}`);
  const measures = by("measure").slice(0, 20).map((r) => `- ${r.title} ${r.value} on ${r.measuredAt?.toISOString().slice(0, 10) ?? ""}`);
  if (measures.length) parts.push(`Measures:\n${measures.join("\n")}`);
  return parts.join("\n\n");
}

/** Draft a referral, discharge or patient letter from the signed record. Without the model: an empty letter to write. */
export async function draftLetter(v: Viewer, clientId: string, input: { letterKind: LetterKind; recipient: string; instructions?: string | null; lang: Lang; sessionId?: string | null }): Promise<{ item: ItemView; usedModel: boolean }> {
  const rec = await loadClient(v, clientId, "write");
  gate(rec, "letter");
  const record = await recordText(v, rec);
  let subject = "", text = "", model: string | null = null, usedModel = false;
  try {
    const out = await completeJson({
      route: "smart", maxTokens: 3000, meta: meta(v, "clinical-letter"),
      messages: letterPrompt({ lang: input.lang, letterKind: input.letterKind, recipient: input.recipient, clientLabel: rec.label, record, instructions: input.instructions ?? undefined }),
      parse: (x) => ({ subject: String((x as { subject?: unknown }).subject ?? ""), body: String((x as { body?: unknown }).body ?? "") }),
    });
    subject = out.subject.slice(0, 200); text = out.body.slice(0, 20_000); model = "mux"; usedModel = true;
  } catch (e) {
    if (!isMuxDown(e)) console.error("[clinical] letter draft", e);
  }
  const [row] = await insertItems(db, v, rec.id, [{
    kind: "letter", status: "proposed", purpose: "notes", sessionId: input.sessionId ?? null, title: subject || null, model,
    content: { letterKind: input.letterKind, recipient: input.recipient, subject, text },
  }], usedModel ? "assistant" : "person");
  return { item: (await views([row]))[0], usedModel };
}

/** A short summary to read before the next consultation (replaces the previous unread one). */
export async function draftSummary(v: Viewer, clientId: string, lang: Lang): Promise<ItemView> {
  const rec = await loadClient(v, clientId, "write");
  gate(rec, "summary");
  const record = await recordText(v, rec);
  if (!record.trim()) throw new ClinicalError(409, "clinical.err.nothingSigned");
  let bullets: string[];
  try {
    bullets = await completeJson({
      route: "smart", maxTokens: 1500, meta: meta(v, "clinical-summary"),
      messages: summaryPrompt({ discipline: rec.discipline, lang, clientLabel: rec.label, record }),
      parse: (x) => {
        const b = (x as { bullets?: unknown }).bullets;
        if (!Array.isArray(b)) throw new Error("bullets must be a list");
        return b.filter((s): s is string => typeof s === "string").map((s) => s.slice(0, 400)).slice(0, 14);
      },
    });
  } catch (e) {
    if (isMuxDown(e)) throw new ClinicalError(503, "clinical.err.muxDown");
    throw e;
  }
  const row = await db.transaction(async (tx) => {
    const old = await tx.select().from(clinicalItems).where(and(eq(clinicalItems.clientNodeId, rec.id), eq(clinicalItems.kind, "summary"), eq(clinicalItems.status, "proposed")));
    for (const o of old) {
      const [u] = await tx.update(clinicalItems).set({ status: "dismissed", version: o.version + 1, updatedAt: new Date() }).where(eq(clinicalItems.id, o.id)).returning();
      await revise(tx, null, u, "replaced");
    }
    return (await insertItems(tx, v, rec.id, [{ kind: "summary", status: "proposed", purpose: "analysis", content: { bullets }, model: "mux" }], "assistant"))[0];
  });
  return (await views([row]))[0];
}

/* ── Practice home ───────────────────────────────────────────────────────────────────────────────────── */

export type HomeData = {
  today: { id: string; clientId: string; clientLabel: string; kind: string; startsAt: string; status: string; work: string }[];
  risks: (ItemView & { clientLabel: string })[];
  toSign: (ItemView & { clientLabel: string })[];
  followups: (ItemView & { clientLabel: string })[];
  reviews: { clientId: string; clientLabel: string; state: string; reviewAt: string | null }[];
  clients: number;
};

export async function practiceHome(v: Viewer, day: { from: Date; to: Date }): Promise<HomeData> {
  const ds = await requireClinical(v);
  const clients = await accessibleClients(v, ds);
  const label = new Map(clients.map((c) => [c.id, c.label]));
  const ids = clients.map((c) => c.id);
  const sess = await db.select().from(clinicalSessions).where(and(eq(clinicalSessions.graphId, v.graphId), eq(clinicalSessions.clinicianId, v.id), gte(clinicalSessions.startsAt, day.from), lt(clinicalSessions.startsAt, day.to))).orderBy(clinicalSessions.startsAt);
  const items = ids.length ? await db.select().from(clinicalItems).where(and(eq(clinicalItems.graphId, v.graphId), inArray(clinicalItems.clientNodeId, ids), sql`(
    (${clinicalItems.kind} = 'risk' and ${clinicalItems.status} = 'open')
    or (${clinicalItems.kind} in ('note', 'letter') and ${clinicalItems.status} = 'proposed' and ${clinicalItems.clinicianId} = ${v.id})
    or (${clinicalItems.kind} = 'followup' and ${clinicalItems.status} in ('proposed', 'confirmed') and ${clinicalItems.clinicianId} = ${v.id}))`)).orderBy(desc(clinicalItems.createdAt)).limit(300) : [];
  const vs = await views(items);
  const withLabel = (x: ItemView) => ({ ...x, clientLabel: label.get(x.clientId) ?? "" });
  const soon = Date.now() + 14 * 86_400_000;
  return {
    today: sess.filter((s) => label.has(s.clientNodeId)).map((s) => ({ id: s.id, clientId: s.clientNodeId, clientLabel: label.get(s.clientNodeId)!, kind: s.kind, startsAt: s.startsAt.toISOString(), status: s.status, work: s.work })),
    risks: vs.filter((x) => x.kind === "risk").map(withLabel),
    toSign: vs.filter((x) => x.kind === "note" || x.kind === "letter").map(withLabel),
    followups: vs.filter((x) => x.kind === "followup" && (x.status === "proposed" || new Date(String(x.content.dueAt ?? 0)).getTime() <= soon))
      .sort((a, b) => String(a.content.dueAt ?? "").localeCompare(String(b.content.dueAt ?? ""))).map(withLabel),
    reviews: clients.filter((c) => c.access === "clinician" && (c.consent.state === "review_soon" || c.consent.state === "expired" || c.consent.state === "none"))
      .map((c) => ({ clientId: c.id, clientLabel: c.label, state: c.consent.state, reviewAt: c.consent.reviewAt?.toISOString() ?? null })),
    clients: clients.length,
  };
}
