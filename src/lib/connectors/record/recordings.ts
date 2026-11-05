/**
 * Recordings as the player and the people pages read them (server-only). Every function takes the viewer and checks
 * that they may read the source (the library's rules) before anything is returned.
 *   getRecording(v, id)          → the source, its time line, its speakers with their person in the graph (or none)
 *   listRecordings(v)            → recordings the viewer may read, newest first
 *   recordingsForPerson(v, node) → the recordings a person took part in (an `involves` edge from the meeting, or their
 *                                  name / email among the speakers)
 *   freshAudio(src)              → a short-lived signed address for the sound, asked of Record with the connection's
 *                                  own sign-in; reused only while it is valid. Never sent to a browser.
 *   peaksFor(v, id)              → the waveform, kept in recording_timelines once fetched
 */
import { roleMention } from "@/lib/meta/roles";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { connections, edges, recordingTimelines, sources } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { proposeChanges } from "@/lib/changes";
import * as gbrain from "@/lib/gbrain";
import { sourceVisibleTo } from "@/lib/ingest/access";
import { getReadableSource } from "@/lib/ingest/library";
import { matchKnownPerson } from "@/lib/ingest/extraction";
import { GENERIC_SPEAKER, momentReceipt, recordingInfo } from "@/lib/ingest/recording";
import { McpClient } from "@/lib/mcp-client/client";
import { McpError } from "@/lib/mcp-client/errors";
import { guardedTransport } from "@/lib/mcp-client/transport";
import { decryptSecrets } from "../crypto";
import { ConnectorError } from "../errors";
import { bearerFor } from "../mcp/auth";
import { mcpConfig } from "../mcp/config";
import { audioFrom, mayPlay, reuseUntil } from "./audio-proxy";

export type SpeakerView = { key: string; name: string; email: string | null; personId: string | null; personLabel: string | null; spoke: boolean };

export type RecordingView = {
  id: string; title: string; link: string | null; tookPlace: string | null; durationMs: number; status: string | null;
  summary: string | null; decisions: string[]; todos: { text: string; owner: string | null; due: string | null; done: boolean }[];
  timing: "exact" | "estimated"; words: { a: number; b: number; w: string; line: number }[];
  lines: { a: number; b: number; speaker: string | null; first: number; last: number; text: string }[];
  speakers: SpeakerView[]; peaks: number[] | null;
  /** The connection can ask Record for the sound (get_meeting_audio is offered). */
  audio: "available" | "not_offered" | "none" | "no_connection";
  isOwner: boolean; eventNodeId: string | null; changeSetId: string | null;
};

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

async function connectionOf(src: { connectionId: string | null; graphId: string }) {
  if (!src.connectionId) return null;
  const [row] = await db.select().from(connections).where(and(eq(connections.id, src.connectionId), eq(connections.graphId, src.graphId))).limit(1);
  if (!row) return null;
  const cfg = mcpConfig.safeParse(row.config);
  return cfg.success ? { row, config: cfg.data } : null;
}

/** The readable recording source (or null), with whether it may be played. */
export async function readableRecording(v: Viewer, id: string) {
  const src = await getReadableSource(v, id);
  if (!src || src.kind !== "recording") return null;
  return src;
}

export async function getRecording(v: Viewer, id: string): Promise<RecordingView | null> {
  const src = await readableRecording(v, id);
  if (!src) return null;
  const [tl] = await db.select().from(recordingTimelines).where(eq(recordingTimelines.sourceId, id)).limit(1);
  const meta = src.meta ?? {};
  const info = recordingInfo(meta);
  const conn = await connectionOf(src);
  const offered = conn?.config.tools?.some((t) => t.name === "get_meeting_audio") ?? false;
  const people = await gbrain.listNodes(v, { type: "person", limit: 500 }).catch(() => [] as gbrain.GNode[]);
  const known = people.map((p) => ({ id: p.id, label: p.label, aliases: p.aliases, email: typeof p.props?.email === "string" ? p.props.email.toLowerCase() : null }));
  // People the meeting's event already involves (delivered), so a speaker matched by a person shows them.
  const eventNodeId = typeof meta.eventNodeId === "string" ? meta.eventNodeId : null;
  const involved = new Set<string>();
  if (eventNodeId) {
    const rows = await db.select({ toId: edges.toId }).from(edges).where(and(eq(edges.graphId, v.graphId), eq(edges.fromId, eventNodeId), eq(edges.relation, "involves"))).catch(() => []);
    for (const r of rows) involved.add(r.toId);
  }
  const lines = tl?.lines ?? [];
  const names = new Map<string, SpeakerView>();
  const add = (name: string, email: string | null, key: string) => {
    if (!name.trim() || names.has(norm(name))) return;
    const byEmail = email ? known.find((k) => k.email === email.toLowerCase()) : undefined;
    const hit = byEmail ?? matchKnownPerson(name, known);
    names.set(norm(name), {
      key, name, email, personId: hit?.id ?? null, personLabel: hit?.label ?? null,
      spoke: lines.some((l) => l.speaker === name),
    });
  };
  for (const s of tl?.speakers ?? []) add(s.name, s.email, s.key);
  for (const n of info?.people ?? []) add(n, null, n);
  for (const l of lines) if (l.speaker) add(l.speaker, null, l.speaker);
  // A speaker not matched by name but already linked to the meeting by a person (delivered) keeps that link.
  const speakers = [...names.values()];
  return {
    id: src.id, title: src.title, link: info?.link ?? src.url ?? null, tookPlace: info?.tookPlace ?? src.documentDate?.toISOString() ?? null,
    durationMs: tl?.durationMs || info?.durationMs || 0, status: typeof (meta.recording as { status?: unknown } | undefined)?.status === "string" ? (meta.recording as { status: string }).status : null,
    summary: info?.summary ?? null, decisions: info?.decisions ?? [], todos: (info?.todos ?? []).map((t) => ({ text: t.text, owner: t.owner, due: t.due, done: t.done })),
    timing: (tl?.timing as "exact" | "estimated") ?? "estimated", words: tl?.words ?? [], lines,
    speakers: speakers.filter((s) => !GENERIC_SPEAKER.test(s.name) || s.spoke), peaks: tl?.peaks ?? null,
    audio: !conn ? "no_connection" : !offered ? "not_offered" : tl?.hasAudio === false ? "none" : "available",
    isOwner: src.ownerId === v.id, eventNodeId, changeSetId: typeof meta.changeSetId === "string" ? meta.changeSetId : null,
  };
}

export type RecordingListItem = { id: string; title: string; tookPlace: string | null; durationMs: number; speakers: string[]; summary: string | null; status: string; link: string | null };

export async function listRecordings(v: Viewer, opts: { limit?: number; q?: string } = {}): Promise<RecordingListItem[]> {
  if (!(await gbrain.accessContext(v)).active) return [];
  const q = opts.q?.trim();
  const rows = await db.select({ id: sources.id, title: sources.title, meta: sources.meta, documentDate: sources.documentDate, status: sources.status, url: sources.url, durationMs: recordingTimelines.durationMs })
    .from(sources).leftJoin(recordingTimelines, eq(recordingTimelines.sourceId, sources.id))
    .where(and(eq(sources.kind, "recording"), sourceVisibleTo(v), ...(q ? [sql`(${sources.title} ilike ${`%${q.replace(/[%_\\]/g, "\\$&")}%`} or ${sources.textContent} ilike ${`%${q.replace(/[%_\\]/g, "\\$&")}%`})`] : [])))
    .orderBy(desc(sql`coalesce(${sources.documentDate}, ${sources.createdAt})`)).limit(Math.min(opts.limit ?? 100, 500));
  return rows.map((r) => {
    const info = recordingInfo(r.meta ?? {});
    return {
      id: r.id, title: r.title, tookPlace: info?.tookPlace ?? r.documentDate?.toISOString() ?? null, durationMs: r.durationMs || info?.durationMs || 0,
      speakers: [...new Set([...(info?.speakers ?? []).map((s) => s.name), ...(info?.people ?? [])])].filter((n) => !GENERIC_SPEAKER.test(n)).slice(0, 8),
      summary: info?.summary ? info.summary.slice(0, 300) : null, status: r.status, link: info?.link ?? r.url,
    };
  });
}

/**
 * The recordings a person took part in, newest first (for their page). Matches the meeting's `involves` edge to them,
 * or their name, an alias or their email among the meeting's speakers and participants.
 */
export async function recordingsForPerson(v: Viewer, nodeId: string): Promise<RecordingListItem[]> {
  const person = await gbrain.getNode(v, nodeId).catch(() => null);
  if (!person || person.type !== "person") return [];
  const names = new Set([person.label, ...person.aliases].map(norm));
  const email = typeof person.props?.email === "string" ? person.props.email.toLowerCase() : null;
  const ev = await db.select({ fromId: edges.fromId }).from(edges).where(and(eq(edges.graphId, v.graphId), eq(edges.toId, person.id), eq(edges.relation, "involves"))).catch(() => []);
  const events = new Set(ev.map((e) => e.fromId));
  const all = await listRecordings(v, { limit: 500 });
  if (!all.length) return [];
  const metas = await db.select({ id: sources.id, meta: sources.meta }).from(sources).where(inArray(sources.id, all.map((r) => r.id)));
  const keep = new Set<string>();
  for (const m of metas) {
    const meta = m.meta ?? {};
    const info = recordingInfo(meta);
    if (typeof meta.eventNodeId === "string" && events.has(meta.eventNodeId)) { keep.add(m.id); continue; }
    const spoke = [...(info?.speakers ?? []), ...(info?.people ?? []).map((n) => ({ name: n, email: null as string | null }))];
    if (spoke.some((s) => names.has(norm(s.name)) || (email && s.email?.toLowerCase() === email))) keep.add(m.id);
  }
  return all.filter((r) => keep.has(r.id));
}

/* ── The sound ───────────────────────────────────────────────────────────────────────────────────────── */

type Signed = { url: string; until: number; mimeType: string | null };
const g = globalThis as unknown as { __mgRecAudio?: Map<string, Signed> };
const signedCache = (g.__mgRecAudio ??= new Map());

export class AudioUnavailable extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/**
 * A fresh signed address for a recording's sound, from Record's get_meeting_audio, asked with the connection's own
 * sign-in (refreshed when needed). Kept in memory only while valid. Also keeps the peaks when Record sends them.
 */
export async function freshAudio(src: { id: string; graphId: string; connectionId: string | null; externalId: string | null }, opts: { force?: boolean } = {}): Promise<Signed> {
  const hit = signedCache.get(src.id);
  if (hit && !opts.force && hit.until > Date.now()) return hit;
  signedCache.delete(src.id);
  const conn = await connectionOf(src);
  if (!conn) throw new AudioUnavailable("The connection this recording came from is gone, so its sound can't be fetched.", 410);
  if (conn.row.status === "paused") throw new AudioUnavailable("The Record connection is paused. Resume it to play the sound.", 409);
  if (!conn.config.tools?.some((t) => t.name === "get_meeting_audio")) throw new AudioUnavailable("Record doesn't hand out the sound of meetings yet. The transcript is all there is for now.", 404);
  let secrets: Record<string, string>;
  try { secrets = decryptSecrets(conn.row.secrets, conn.row.id); } catch { throw new AudioUnavailable("The Record sign-in can't be read. Sign in again under Connections.", 409); }
  const transport = guardedTransport();
  const client = new McpClient({ url: conn.config.serverUrl, transport, perMinute: 60, timeoutMs: 20_000, token: () => bearerFor({ id: conn.row.id, config: conn.config }, secrets, transport) });
  const meetingId = (src.externalId ?? "").replace(/^record:/, "");
  let r;
  try {
    r = await client.callTool("get_meeting_audio", { id: meetingId });
  } catch (e) {
    if (e instanceof ConnectorError) throw new AudioUnavailable("Record needs you to sign in again (Connections).", 409);
    if (e instanceof McpError) throw new AudioUnavailable(e.code === "auth" ? "Record needs you to sign in again (Connections)." : `Record didn't answer: ${e.message}`, e.code === "auth" ? 409 : 502);
    throw e;
  }
  const a = r.isError ? null : audioFrom(r.data);
  if (!a) {
    await db.update(recordingTimelines).set({ hasAudio: false }).where(eq(recordingTimelines.sourceId, src.id)).catch(() => {});
    throw new AudioUnavailable(r.text && r.isError ? `Record: ${r.text.slice(0, 200)}` : "Record has no sound for this meeting.", 404);
  }
  await db.update(recordingTimelines).set({ hasAudio: true, ...(a.peaks ? { peaks: a.peaks } : {}) }).where(eq(recordingTimelines.sourceId, src.id)).catch(() => {});
  const signed = { url: a.url, until: reuseUntil(a.expiresAt), mimeType: a.mimeType };
  if (signed.until > Date.now()) signedCache.set(src.id, signed);
  return signed;
}

/** The source row the audio route needs, access-checked. */
export async function playableSource(v: Viewer, id: string) {
  const src = await getReadableSource(v, id);
  // getReadableSource already applied the read rules (with shares); mayPlay adds "is a recording with its connection".
  return src && mayPlay(v, { ...src, householdId: src.householdId }, true) ? src : null;
}

/** The waveform: kept, or fetched with the sound's address (Record sends both together). hasAudio false: no sound. */
export async function peaksFor(v: Viewer, id: string): Promise<{ durationMs: number; peaks: number[] | null; hasAudio: boolean } | null> {
  const src = await playableSource(v, id);
  if (!src) return null;
  const read = async () => (await db.select({ peaks: recordingTimelines.peaks, durationMs: recordingTimelines.durationMs, hasAudio: recordingTimelines.hasAudio })
    .from(recordingTimelines).where(eq(recordingTimelines.sourceId, id)).limit(1))[0];
  let tl = await read();
  if (tl?.peaks?.length) return { durationMs: tl.durationMs, peaks: tl.peaks, hasAudio: true };
  let ok = true;
  await freshAudio(src).catch(() => { ok = false; });
  tl = await read();
  return { durationMs: tl?.durationMs ?? 0, peaks: tl?.peaks?.length ? tl.peaks : null, hasAudio: ok && tl?.hasAudio !== false };
}

/**
 * "Propose as person": a speaker nobody in the graph matches becomes a proposed person (and, when the meeting is on the
 * timeline already, linked to it), with a receipt at the first moment they speak. A person delivers it.
 */
export async function proposeSpeaker(v: Viewer, id: string, name: string): Promise<{ changeSetId: string } | null> {
  const src = await readableRecording(v, id);
  if (!src) return null;
  const clean = name.replace(/\s+/g, " ").trim().slice(0, 120);
  if (!clean || GENERIC_SPEAKER.test(clean)) throw new AudioUnavailable("Give the person a name first; a numbered speaker can't be proposed.", 400);
  if (roleMention(clean)) throw new AudioUnavailable("That is a role, not a name. Give the person's name to propose them.", 400);
  const meta = src.meta ?? {};
  const info = recordingInfo(meta) ?? { link: src.url ?? null };
  const [tl] = await db.select({ lines: recordingTimelines.lines, speakers: recordingTimelines.speakers }).from(recordingTimelines).where(eq(recordingTimelines.sourceId, id)).limit(1);
  const line = (tl?.lines ?? []).find((l) => l.speaker === clean) ?? tl?.lines?.[0];
  const email = (tl?.speakers ?? []).find((s) => s.name === clean)?.email ?? null;
  const receipt = momentReceipt(src.id, info, line, line ? `${clean}: ${line.text}` : `${clean} took part in “${src.title}”.`, 0.9);
  const personId = crypto.randomUUID();
  const eventNodeId = typeof meta.eventNodeId === "string" ? meta.eventNodeId : null;
  const event = eventNodeId ? await gbrain.getNode(v, eventNodeId).catch(() => null) : null;
  const res = await proposeChanges(v, {
    title: `Add ${clean}, from “${src.title.slice(0, 100)}”`,
    description: "Proposed from the recording's speakers. Nothing is added until you deliver it.",
    origin: "person", evidence: { sourceId: src.id, ...(info.link ? { url: info.link } : {}) }, forUserId: v.id,
    changes: [
      { op: "addNode", nodeId: personId, type: "person", label: clean, ...(email ? { props: { email } } : {}), visibility: src.visibility, note: `Speaks in “${src.title}”.`, receipt },
      ...(event ? [{ op: "addEdge" as const, fromId: event.id, toId: personId, relation: "involves", status: "unconfirmed" as const, confidence: 0.95, note: "They speak in the recording.", receipt }] : []),
    ],
  });
  return res ? { changeSetId: res.id } : null;
}
