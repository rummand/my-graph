/**
 * The ingestion pipeline. Server-only. Runs in-process after the upload returns; progress lives on the source row
 * (status pending → processing → ready | failed, with `error` and details in `meta`).
 *   1. text extraction (files only)   2. chunk + embed   3. the source's document node
 *   4. entity/fact extraction via mux with provenance   5. reminders for upcoming events involving a child
 * When mux is down, 1–3 still complete and the source ends up ready with meta.extraction = "skipped: mux unreachable".
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { chunks, reminders, sources, users } from "@/db/schema";
import type { Locator } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import * as gbrain from "@/lib/gbrain";
import * as mux from "@/lib/mux";
import { getMeta, type Meta as MetaHelpers, type MetaNodeType } from "@/lib/meta";
import { readStored } from "@/lib/storage";
import { chunkSegments, groupChunks, type TextSegment } from "./chunk";
import { extractText } from "./extract-text";
import {
  buildExtractionMessages, clampConfidence, edgeStatusFor, findQuoteChunk, matchKnownPerson, parseExtraction, reminderDueAt,
  type Extraction, type KnownPerson,
} from "./extraction";
import { kindFromMime } from "./mime";

const AGENT = "library-ingest";
const EMBED_BATCH = 32;
const INSERT_BATCH = 200;
const MAX_EXTRACTION_GROUPS = 40; // ~160k characters; longer documents are only partly read for facts

type StoredChunk = { id: string; idx: number; text: string; locator: Locator };
type Meta = Record<string, unknown>;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

/* ── A small in-process queue so a burst of uploads doesn't run 20 OCR jobs at once ──────────────────────── */

const g = globalThis as unknown as { __ingestQueue?: { running: number; waiting: (() => void)[] } };
const queue = (g.__ingestQueue ??= { running: 0, waiting: [] });
const CONCURRENCY = 2;

export function enqueue(job: () => Promise<void>): void {
  const run = () => {
    queue.running++;
    job()
      .catch((e) => console.error("[ingest] job crashed", e))
      .finally(() => {
        queue.running--;
        queue.waiting.shift()?.();
      });
  };
  if (queue.running < CONCURRENCY) run();
  else queue.waiting.push(run);
}

/* ── Pipeline ─────────────────────────────────────────────────────────────────────────────────────────── */

async function muxIsUp(): Promise<boolean> {
  try {
    return (await mux.muxHealth()).ok;
  } catch {
    return false;
  }
}

/**
 * Process one source end to end. Never throws: failures are written to the source row.
 * `fromFile`: run text extraction on the stored original; otherwise use the source's existing textContent.
 */
export async function processSource(v: Viewer, sourceId: string, opts: { fromFile: boolean }): Promise<void> {
  const [src] = await db.select().from(sources).where(eq(sources.id, sourceId)).limit(1);
  if (!src) return;
  const meta: Meta = { ...(src.meta ?? {}) };
  delete meta.extraction; delete meta.extracted; delete meta.warnings; delete meta.failedStep;
  const warnings: string[] = [];
  await db.update(sources).set({ status: "processing", error: null, meta: { ...meta, startedAt: new Date().toISOString() } }).where(eq(sources.id, sourceId));

  let step = "reading the file";
  try {
    const muxUp = await muxIsUp();
    const muxMeta: mux.MuxCallMeta = { userId: v.id, agent: AGENT, traceId: sourceId, sensitive: src.sensitive };

    // 1. Text extraction
    let segments: TextSegment[];
    let textContent = src.textContent ?? "";
    let occurredAt: Date | undefined;
    let textActivity: "upload" | "ocr" | "transcription" | "import" = opts.fromFile ? "upload" : "import";
    if (opts.fromFile) {
      const kind = kindFromMime(src.mime);
      if (!kind || !src.storageKey) throw new Error("The original file is missing or of an unknown type.");
      const bytes = await readStored(src.storageKey);
      step = "reading the text";
      const ex = await extractText({ bytes, mime: src.mime!, kind, filename: src.title, sensitive: src.sensitive, muxUp, muxMeta });
      segments = ex.segments;
      textContent = ex.textContent;
      occurredAt = ex.occurredAt;
      textActivity = ex.activity;
      Object.assign(meta, ex.meta);
      warnings.push(...ex.warnings);
      await db.update(sources).set({ textContent, meta: { ...meta, warnings } }).where(eq(sources.id, sourceId));
    } else {
      segments = textContent.trim() ? [{ text: textContent }] : [];
    }

    // 2. Chunk + embed
    step = "splitting the text";
    const stored = await replaceChunks(src.id, src.ownerId, segments);
    meta.chunks = stored.length;
    step = "indexing for search";
    meta.embedding = await embedChunks(stored, muxMeta, muxUp);

    // 3. Document node
    step = "adding it to the graph";
    let docNodeId = src.nodeId;
    if (!docNodeId) {
      const { node } = await gbrain.upsertNode(v, {
        type: "document",
        label: src.title,
        summary: typeof meta.captionText === "string" ? meta.captionText : undefined,
        props: { sourceId: src.id, mime: src.mime, kind: src.kind },
        startAt: occurredAt ?? null,
        timePrecision: occurredAt ? "minute" : null,
        visibility: src.visibility,
        sensitive: src.sensitive,
      }, { sourceId: src.id, activity: textActivity, agentType: "user", agentId: v.id, confidence: 1 });
      docNodeId = node.id;
      await db.update(sources).set({ nodeId: docNodeId }).where(eq(sources.id, sourceId));
    }

    // 4–5. Extraction + reminders
    step = "finding people, places and events";
    if (!muxUp) meta.extraction = "skipped: mux unreachable";
    else if (stored.length === 0) meta.extraction = "skipped: no text";
    else {
      const r = await extractFacts(v, { id: src.id, title: src.title, visibility: src.visibility, sensitive: src.sensitive, docNodeId }, stored, muxMeta);
      meta.extraction = r.summary;
      meta.extracted = r.counts;
      if (r.model) meta.extractionModel = r.model;
      step = "creating reminders";
      meta.reminders = await createReminders(v, src.id, src.title, r.events);
    }

    meta.warnings = warnings;
    meta.finishedAt = new Date().toISOString();
    await db.update(sources).set({ status: "ready", error: null, meta }).where(eq(sources.id, sourceId));
  } catch (e) {
    console.error(`[ingest] source ${sourceId} failed while ${step}`, e);
    meta.warnings = warnings;
    meta.failedStep = step;
    meta.finishedAt = new Date().toISOString();
    await db.update(sources)
      .set({ status: "failed", error: `Failed while ${step}: ${errText(e)}`, meta })
      .where(eq(sources.id, sourceId))
      .catch((e2) => console.error("[ingest] could not record failure", e2));
  }
}

async function replaceChunks(sourceId: string, ownerId: string, segments: TextSegment[]): Promise<StoredChunk[]> {
  const pieces = chunkSegments(segments);
  return db.transaction(async (tx) => {
    await tx.delete(chunks).where(eq(chunks.sourceId, sourceId));
    const out: StoredChunk[] = [];
    for (let i = 0; i < pieces.length; i += INSERT_BATCH) {
      const rows = pieces.slice(i, i + INSERT_BATCH).map((p, j) => ({
        sourceId, ownerId, idx: i + j, text: p.text, locator: p.locator,
        search: sql`to_tsvector('simple', ${p.text})`,
      }));
      const ins = await tx.insert(chunks).values(rows).returning({ id: chunks.id, idx: chunks.idx, text: chunks.text, locator: chunks.locator });
      out.push(...ins);
    }
    return out.sort((a, b) => a.idx - b.idx);
  });
}

async function embedChunks(stored: StoredChunk[], meta: mux.MuxCallMeta, muxUp: boolean): Promise<string> {
  if (stored.length === 0) return "skipped: no text";
  if (!muxUp) return "skipped: mux unreachable (keyword search still works)";
  let done = 0;
  try {
    for (let i = 0; i < stored.length; i += EMBED_BATCH) {
      const batch = stored.slice(i, i + EMBED_BATCH);
      const vecs = await mux.embed(batch.map((c) => c.text), meta);
      if (!vecs) return done ? `partial: ${done} of ${stored.length}` : "skipped: mux unreachable (keyword search still works)";
      for (let j = 0; j < batch.length; j++) {
        const vec = vecs[j];
        if (!Array.isArray(vec) || vec.length !== 1024) continue;
        await db.update(chunks).set({ embedding: vec }).where(eq(chunks.id, batch[j].id));
        done++;
      }
    }
    return done === stored.length ? "done" : `partial: ${done} of ${stored.length}`;
  } catch (e) {
    return `failed: ${errText(e)}`;
  }
}

/* ── Step 4: entity and fact extraction ──────────────────────────────────────────────────────────────── */

type SourceCtx = { id: string; title: string; visibility: "private" | "parents" | "household"; sensitive: boolean; docNodeId: string };
export type FoundEvent = { nodeId: string; label: string; startAt: Date; personIds: Set<string> };

function stripFences(s: string): string {
  const t = s.trim();
  const fenced = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) return fenced[1];
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  return first >= 0 && last > first ? t.slice(first, last + 1) : t;
}

/**
 * One extraction call. Uses mux.complete (json mode) rather than completeJson so the serving model's name reaches
 * provenance (agentId "mux:<model>"); retries once with the validation error, like completeJson does.
 */
async function extractGroup(messages: mux.MuxMessage[], meta: mux.MuxCallMeta): Promise<{ data: Extraction; model: string | null }> {
  let msgs = messages;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await mux.complete({ route: "agent", messages: msgs, json: true, maxTokens: 2500, temperature: 0, meta });
    try {
      return { data: parseExtraction(JSON.parse(stripFences(r.text))), model: r.model ?? r.route };
    } catch (e) {
      lastErr = e;
      msgs = [...messages, { role: "assistant", content: r.text.slice(0, 4000) }, { role: "user", content: `That was not valid. ${errText(e).slice(0, 300)} Answer again with only the JSON object.` }];
    }
  }
  throw lastErr;
}

async function knownPeople(v: Viewer): Promise<(KnownPerson & { props: Record<string, unknown> })[]> {
  try {
    const people = await gbrain.listNodes(v, { type: "person", limit: 300 });
    return people.map((p) => ({ id: p.id, label: p.label, aliases: p.aliases, props: p.props }));
  } catch (e) {
    console.warn("[ingest] could not list known people", errText(e));
    return [];
  }
}

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

async function extractFacts(v: Viewer, src: SourceCtx, stored: StoredChunk[], meta: mux.MuxCallMeta) {
  const known = await knownPeople(v);
  // The household's meta model, loaded once: used to give extracted nodes a kind (teacher, school, …).
  let meta_: MetaHelpers | null = null;
  try { meta_ = await getMeta(v); } catch (e) { console.warn("[ingest] meta model unavailable", errText(e)); }
  const kindFor = (type: string, label: string, text: string, relations: string[]): string | null => {
    if (!meta_) return null;
    try {
      const s = meta_.suggestKind(label, { type: type as MetaNodeType, text, relations });
      return s && s.type === type ? s.kind : null;
    } catch { return null; }
  };
  const labelToId = new Map<string, string>();
  const nodeType = new Map<string, string>(); // id → type
  for (const p of known) {
    nodeType.set(p.id, "person");
  }
  const resolve = (label: string): string | undefined => labelToId.get(norm(label)) ?? matchKnownPerson(label, known)?.id;

  const mentioned = new Set<string>();
  const events = new Map<string, FoundEvent>();
  const counts = { groups: 0, failedGroups: 0, entities: 0, facts: 0, dropped: 0 };
  let model: string | null = null;
  let lastError = "";

  const groups = groupChunks(stored, 4000).slice(0, MAX_EXTRACTION_GROUPS);
  const totalGroups = groupChunks(stored, 4000).length;

  for (const group of groups) {
    counts.groups++;
    let ex: Extraction;
    try {
      const r = await extractGroup(buildExtractionMessages({ title: src.title, text: group.map((c) => c.text).join("\n\n"), known, today: new Date(), viewerName: v.name }), meta);
      ex = r.data;
      model = r.model ?? model;
    } catch (e) {
      counts.failedGroups++;
      lastError = errText(e);
      continue;
    }
    counts.dropped += ex.dropped;
    const agentId = `mux:${model ?? "agent"}`;
    const prov = (chunk: StoredChunk | undefined, quote: string | null, confidence: number) => ({
      sourceId: src.id, chunkId: chunk?.id ?? null, locator: chunk?.locator ?? {}, quote,
      activity: "llm_extraction" as const, agentType: "model" as const, agentId, confidence,
    });
    const chunkMentioning = (label: string) => group.find((c) => norm(c.text).includes(norm(label))) ?? group[0];

    // Entities → nodes
    for (const ent of ex.entities) {
      try {
        let id = ent.type === "person" ? matchKnownPerson(ent.label, known)?.id : undefined;
        id ??= labelToId.get(norm(ent.label));
        const chunk = chunkMentioning(ent.label);
        if (!id) {
          const key = norm(ent.label);
          const relations = ex.facts.filter((f) => norm(f.from) === key || norm(f.to) === key).map((f) => f.relation);
          // Context: the label, plus the entity's own summary for people (a role like "class teacher"). Not the whole
          // chunk — a letter naming a school would make every place a "school" — and not event summaries, which name
          // the event a deadline belongs to ("deadline … for the field trip" is not a trip).
          const kind = kindFor(ent.type, ent.label, ent.type === "person" ? ent.summary ?? "" : "", relations);
          const { node } = await gbrain.upsertNode(v, {
            type: ent.type, kind, label: ent.label, aliases: ent.aliases, summary: ent.summary,
            startAt: ent.startAt ?? null, endAt: ent.endAt ?? null,
            timePrecision: ent.startAt ? ent.precision ?? "day" : null,
            visibility: src.visibility, sensitive: src.sensitive,
          }, prov(chunk, null, 0.8));
          id = node.id;
          counts.entities++;
          if (node.type === "event" && node.startAt && !events.has(id)) events.set(id, { nodeId: id, label: node.label, startAt: node.startAt, personIds: new Set() });
        }
        labelToId.set(norm(ent.label), id);
        for (const a of ent.aliases) labelToId.set(norm(a), id);
        nodeType.set(id, ent.type);
        if (ent.type === "event" && ent.startAt && !events.has(id)) events.set(id, { nodeId: id, label: ent.label, startAt: ent.startAt, personIds: new Set() });
        if (!mentioned.has(id)) {
          mentioned.add(id);
          await gbrain.addEdge(v, { fromId: src.docNodeId, toId: id, relation: "mentions", confidence: 0.95, status: "confirmed", visibility: src.visibility },
            prov(chunk, null, 0.95));
        }
      } catch (e) {
        counts.dropped++;
        lastError = errText(e);
      }
    }

    // Facts → edges
    for (const f of ex.facts) {
      let fromId = resolve(f.from);
      let toId = resolve(f.to);
      if (!fromId || !toId || fromId === toId) { counts.dropped++; continue; }
      // "involves" always points event → person.
      if (f.relation === "involves" && nodeType.get(fromId) === "person" && nodeType.get(toId) === "event") [fromId, toId] = [toId, fromId];
      const confidence = clampConfidence(f.confidence);
      const chunk = findQuoteChunk(f.quote, group) ?? group[0];
      try {
        await gbrain.addEdge(v, { fromId, toId, relation: f.relation, confidence, status: edgeStatusFor(confidence), visibility: src.visibility },
          prov(chunk, f.quote ?? null, confidence));
        counts.facts++;
        if (f.relation === "involves" && events.has(fromId) && nodeType.get(toId) === "person") events.get(fromId)!.personIds.add(toId);
      } catch (e) {
        counts.dropped++;
        lastError = errText(e);
      }
    }
  }

  let summary: string;
  if (counts.failedGroups === counts.groups) summary = `failed: ${lastError || "the model gave no usable answer"}`;
  else if (counts.failedGroups > 0) summary = `partial: ${counts.failedGroups} of ${counts.groups} parts could not be read (${lastError})`;
  else summary = "done";
  if (totalGroups > groups.length) summary += ` (only the first ${groups.length} of ${totalGroups} parts were read for facts)`;
  return { summary, counts, model, events: [...events.values()], known };
}

/* ── Step 5: reminders ───────────────────────────────────────────────────────────────────────────────── */

function isChildNode(props: Record<string, unknown>, now: Date): boolean {
  if (props.role === "child" || props.isChild === true || props.child === true) return true;
  const by = typeof props.birthYear === "number" ? props.birthYear : Number(props.birthYear);
  return Number.isFinite(by) && by > 1900 && now.getUTCFullYear() - by < 18;
}

async function createReminders(v: Viewer, sourceId: string, sourceTitle: string, events: FoundEvent[]): Promise<number> {
  const now = new Date();
  const upcoming = events.filter((e) => e.startAt.getTime() > now.getTime() && e.personIds.size > 0);
  if (upcoming.length === 0) return 0;

  const personIds = [...new Set(upcoming.flatMap((e) => [...e.personIds]))];
  const childUsers = await db.select({ personNodeId: users.personNodeId, name: users.name })
    .from(users).where(and(eq(users.householdId, v.householdId), eq(users.role, "child")));
  const children = new Map<string, string>();
  for (const u of childUsers) if (u.personNodeId) children.set(u.personNodeId, u.name);
  const known = await knownPeople(v);
  for (const p of known) if (personIds.includes(p.id) && isChildNode(p.props, now)) children.set(p.id, children.get(p.id) ?? p.label);

  let created = 0;
  for (const ev of upcoming) {
    for (const pid of ev.personIds) {
      const childName = children.get(pid);
      if (!childName) continue;
      const dueAt = reminderDueAt(ev.startAt, now);
      if (!dueAt) continue;
      const existing = await db.select({ id: reminders.id }).from(reminders)
        .where(and(eq(reminders.ownerId, v.id), eq(reminders.nodeId, ev.nodeId), eq(reminders.aboutNodeId, pid))).limit(1);
      if (existing.length) continue;
      await db.insert(reminders).values({
        householdId: v.householdId, ownerId: v.id, aboutNodeId: pid, nodeId: ev.nodeId, sourceId,
        title: `${childName}: ${ev.label}`,
        detail: `Coming up on ${ev.startAt.toISOString().slice(0, 10)}. Found in “${sourceTitle}”.`,
        dueAt, createdByKind: "assistant",
      });
      created++;
    }
  }
  return created;
}
