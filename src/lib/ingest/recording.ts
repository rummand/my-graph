/**
 * Recordings (meetings from Record) in the reading pipeline, pure. A recording source's text is its transcript; here
 * each line becomes a timed segment (so every chunk, and every receipt, points at a moment: locator `{ time }` in ms),
 * and the meeting itself proposes: the meeting as an event, its speakers and participants as people (matched to people
 * already in the graph by email, then by name), each linked to the meeting, its decisions, and its open to-dos as
 * reminders. Every op has a receipt with the quote, the moment and Record's link to that moment.
 */
import type { ChangeInput, Receipt } from "@/lib/changes";
import { matchKnownPerson } from "./extraction";
import { edgeKey, type KnownNode } from "./proposals";
import type { TextSegment } from "./chunk";

export type RecLine = { a: number; b: number; speaker: string | null; text: string };
export type RecSpeaker = { key: string; name: string; email: string | null };
export type RecTodo = { id: string | null; text: string; owner: string | null; due: string | null; done: boolean };
export type RecordingInfo = {
  id: string; link: string | null; tookPlace: string | null; durationMs: number; summary: string | null;
  people: string[]; decisions: string[]; todos: RecTodo[]; speakers: RecSpeaker[];
};

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/** Read the recording part of a source's meta (written by the Record connector). */
export function recordingInfo(meta: Record<string, unknown>): RecordingInfo | null {
  const r = meta.recording as Record<string, unknown> | undefined;
  if (!r || typeof r.id !== "string") return null;
  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  return {
    id: r.id, link: typeof r.link === "string" ? r.link : null, tookPlace: typeof r.tookPlace === "string" ? r.tookPlace : null,
    durationMs: Number(r.durationMs) || 0, summary: typeof r.summary === "string" ? r.summary : null,
    people: arr<unknown>(r.people).filter((x): x is string => typeof x === "string"),
    decisions: arr<unknown>(r.decisions).filter((x): x is string => typeof x === "string"),
    todos: arr<RecTodo>(r.todos).filter((t) => t && typeof t.text === "string"),
    speakers: arr<RecSpeaker>(r.speakers).filter((s) => s && typeof s.name === "string"),
  };
}

/** One timed segment per transcript line ("Speaker: words"), carrying the line's moment in ms. */
export function recordingSegments(lines: RecLine[]): TextSegment[] {
  return lines.filter((l) => l.text.trim()).map((l) => ({
    text: l.speaker ? `${l.speaker}: ${l.text}` : l.text,
    timeStartSec: l.a / 1000, timeEndSec: Math.max(l.a, l.b) / 1000,
    at: { time: l.a, ...(l.speaker ? { speaker: l.speaker } : {}) },
  }));
}

/** Record's link to a moment: the meeting's page takes ?t=<seconds>. */
export function momentLink(link: string | null, ms: number): string | undefined {
  if (!link) return undefined;
  try {
    const u = new URL(link);
    u.searchParams.set("t", String(Math.floor(ms / 1000)));
    return u.toString();
  } catch {
    return undefined;
  }
}

/** The line a short text (a decision, a to-do) was most likely said in: the most shared words, earliest on a tie. */
export function bestLine(text: string, lines: RecLine[]): number {
  const words = new Set(norm(text).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3));
  if (!words.size || !lines.length) return -1;
  let best = -1, score = 0;
  lines.forEach((l, i) => {
    const lw = new Set(norm(l.text).split(/[^\p{L}\p{N}]+/u));
    let s = 0;
    for (const w of words) if (lw.has(w)) s++;
    if (s > score) { score = s; best = i; }
  });
  return score >= Math.min(2, words.size) ? best : -1;
}

/** The line a quote comes from (whole quote, else its first 40 characters). */
export function lineOfQuote(quote: string, lines: RecLine[]): number {
  const q = norm(quote).replace(/^…|…$/g, "");
  if (!q) return -1;
  const i = lines.findIndex((l) => norm(`${l.speaker ? `${l.speaker}: ` : ""}${l.text}`).includes(q) || norm(l.text).includes(q));
  if (i >= 0) return i;
  const head = q.slice(0, 40);
  return head.length >= 12 ? lines.findIndex((l) => norm(l.text).includes(head)) : -1;
}

export function momentReceipt(sourceId: string, info: Pick<RecordingInfo, "link">, line: RecLine | undefined, quote: string | undefined, confidence: number): Receipt {
  const ms = line?.a ?? 0;
  return {
    sourceId, quote: quote?.slice(0, 300), confidence,
    locator: line ? { time: ms, timeStartSec: ms / 1000, timeEndSec: Math.max(ms, line.b) / 1000, ...(line.speaker ? { speaker: line.speaker } : {}) } : { time: 0 },
    url: momentLink(info.link, ms),
  };
}

/** Give receipts that quote the transcript the moment of their line (and Record's link to it). Mutates `changes`. */
export function refineReceipts(changes: ChangeInput[], sourceId: string, info: Pick<RecordingInfo, "link">, lines: RecLine[]): void {
  for (const c of changes) {
    const r = c.receipt;
    // Receipts the meeting made itself already carry their moment and link.
    if (!r || r.sourceId !== sourceId || r.url) continue;
    const i = r.quote ? lineOfQuote(r.quote, lines) : -1;
    if (i >= 0) {
      c.receipt = { ...momentReceipt(sourceId, info, lines[i], r.quote, r.confidence ?? 0.8), chunkId: r.chunkId };
      continue;
    }
    const start = Number((r.locator as { timeStartSec?: number } | undefined)?.timeStartSec);
    if (Number.isFinite(start)) c.receipt = { ...r, locator: { ...(r.locator ?? {}), time: Math.round(start * 1000) }, url: momentLink(info.link, start * 1000) };
  }
}

/** Generic speaker labels ("Speaker 2", "Taler 1") name nobody. */
export const GENERIC_SPEAKER = /^(speaker|taler|talker|person|participant|deltager|unknown|ukendt|guest|gæst)\s*\d*$/i;

export type RecordingPlan = {
  changes: ChangeInput[];
  /** What the meeting adds that the rest of the reading should treat as known (the meeting, its people, decisions). */
  known: KnownNode[];
  /** Edges it proposes, so the reading doesn't propose them again. */
  edgeKeys: string[];
  counts: { people: number; events: number; other: number; connections: number; reminders: number };
};

/**
 * The reading of a transcript often names the meeting itself as an event ("Parent meeting about the class trip"),
 * sometimes on another day. That is the meeting: its add is dropped and what pointed at it points at the meeting;
 * edges the meeting already proposes are not proposed twice. Mutates `changes`.
 */
export function foldIntoMeeting(changes: ChangeInput[], meeting: { title: string; eventNodeId: string; edgeKeys: ReadonlySet<string> }): void {
  const same = new Set(changes.flatMap((c) => (c.op === "addNode" && c.type === "event" && c.nodeId && norm(c.label) === norm(meeting.title) ? [c.nodeId] : [])));
  const seen = new Set(meeting.edgeKeys);
  for (let i = changes.length - 1; i >= 0; i--) if (changes[i].op === "addNode" && same.has((changes[i] as { nodeId?: string }).nodeId ?? "")) changes.splice(i, 1);
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    if (c.op !== "addEdge") continue;
    const fromId = same.has(c.fromId) ? meeting.eventNodeId : c.fromId;
    const toId = same.has(c.toId) ? meeting.eventNodeId : c.toId;
    const key = edgeKey(fromId, c.relation, toId);
    if (fromId === toId || seen.has(key)) { changes.splice(i--, 1); continue; }
    seen.add(key);
    changes[i] = { ...c, fromId, toId };
  }
}

/** Remove proposed people with a generic speaker label ("Speaker 4"), and everything that points at them. Returns how many. */
export function dropGenericPeople(changes: ChangeInput[]): number {
  const drop = new Set(changes.flatMap((c) => (c.op === "addNode" && c.type === "person" && GENERIC_SPEAKER.test(c.label.trim()) && c.nodeId ? [c.nodeId] : [])));
  if (!drop.size) return 0;
  for (let i = changes.length - 1; i >= 0; i--) {
    const c = changes[i];
    if ((c.op === "addNode" && c.nodeId && drop.has(c.nodeId)) || (c.op === "addEdge" && (drop.has(c.fromId) || drop.has(c.toId))) || (c.op === "addReminder" && c.aboutNodeId && drop.has(c.aboutNodeId))) changes.splice(i, 1);
  }
  return drop.size;
}

/** What a meeting proposes. Idempotent against what the graph already holds (known nodes, existing edges). */
export function recordingOps(input: {
  info: RecordingInfo; title: string; sourceId: string; docNodeId: string | null; eventNodeId: string; eventExists: boolean;
  lines: RecLine[]; known: KnownNode[]; existingEdges: ReadonlySet<string>; visibility: "private" | "parents" | "household";
  mint: () => string; now?: Date;
}): RecordingPlan {
  const { info, lines } = input;
  const changes: ChangeInput[] = [];
  const counts = { people: 0, events: 0, other: 0, connections: 0, reminders: 0 };
  const proposedPeople: KnownNode[] = [];
  const knownMore: KnownNode[] = [{ id: input.eventNodeId, type: "event", label: input.title, aliases: [], startAt: info.tookPlace }];
  const edges = new Set(input.existingEdges);
  const addEdge = (fromId: string, relation: string, toId: string, receipt: Receipt, confidence: number, note: string) => {
    const k = edgeKey(fromId, relation, toId);
    if (edges.has(k)) return;
    edges.add(k);
    changes.push({ op: "addEdge", fromId, toId, relation, confidence, status: "unconfirmed", note, receipt });
    counts.connections++;
  };
  const first = lines[0];
  const eventReceipt = momentReceipt(input.sourceId, info, first, `${input.title}${info.tookPlace ? `, ${info.tookPlace.slice(0, 10)}` : ""}`, 1);

  // The meeting itself, on the timeline.
  if (!input.eventExists) {
    const start = info.tookPlace ? new Date(info.tookPlace) : null;
    changes.push({
      op: "addNode", nodeId: input.eventNodeId, type: "event", label: input.title.slice(0, 200),
      summary: info.summary ? info.summary.replace(/\s+/g, " ").slice(0, 600) : undefined,
      props: { recording: true, recordId: info.id, ...(info.link ? { recordingUrl: info.link } : {}), ...(info.durationMs ? { durationMs: info.durationMs } : {}) },
      startAt: start?.toISOString() ?? null, endAt: start && info.durationMs ? new Date(start.getTime() + info.durationMs).toISOString() : null,
      visibility: input.visibility, note: "Recorded in Record.", receipt: eventReceipt,
    });
    counts.events++;
  }
  if (input.docNodeId) addEdge(input.docNodeId, "about", input.eventNodeId, eventReceipt, 1, "The recording of the meeting.");

  // People: who spoke (from the time line) and who took part (Record's list).
  const people = input.known.filter((k) => k.type === "person");
  const seen = new Map<string, string>();
  const candidates: { name: string; email: string | null; spoke: boolean }[] = [];
  for (const s of info.speakers) candidates.push({ name: s.name, email: s.email, spoke: lines.some((l) => l.speaker === s.name) });
  for (const n of info.people) if (!candidates.some((c) => norm(c.name) === norm(n))) candidates.push({ name: n, email: null, spoke: lines.some((l) => l.speaker === n) });
  for (const c of candidates) {
    const name = c.name.trim();
    if (!name || GENERIC_SPEAKER.test(name) || seen.has(norm(name))) continue;
    const firstLine = lines.find((l) => l.speaker === name);
    const receipt = momentReceipt(input.sourceId, info, firstLine ?? first, firstLine ? `${name}: ${firstLine.text}` : `${name} took part in “${input.title}”.`, c.spoke ? 0.95 : 0.8);
    const byEmail = c.email ? people.find((k) => (k.email ?? "").toLowerCase() === c.email!.toLowerCase()) : undefined;
    const match = byEmail ?? matchKnownPerson(name, people);
    let id = match?.id;
    if (!id) {
      id = input.mint();
      changes.push({
        op: "addNode", nodeId: id, type: "person", label: name, aliases: [], ...(c.email ? { props: { email: c.email } } : {}),
        visibility: input.visibility, note: c.spoke ? `Spoke in “${input.title}”.` : `Took part in “${input.title}”.`, receipt,
      });
      proposedPeople.push({ id, type: "person", label: name, aliases: [], email: c.email });
      counts.people++;
    }
    seen.set(norm(name), id);
    addEdge(input.eventNodeId, "involves", id, receipt, c.spoke ? 0.95 : 0.8, c.spoke ? "They speak in the recording." : "Record lists them as taking part.");
  }

  // Decisions: one topic each, about the meeting.
  for (const d of info.decisions.slice(0, 30)) {
    const text = d.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const i = bestLine(text, lines);
    const id = input.mint();
    const known = input.known.find((k) => k.type === "topic" && norm(k.label) === norm(text.slice(0, 160)));
    const receipt = momentReceipt(input.sourceId, info, lines[i] ?? first, i >= 0 ? `${lines[i].speaker ? `${lines[i].speaker}: ` : ""}${lines[i].text}` : text, 0.85);
    const topicId = known?.id ?? id;
    if (!known) {
      knownMore.push({ id, type: "topic", label: text.slice(0, 160), aliases: [] });
      changes.push({
        op: "addNode", nodeId: id, type: "topic", label: text.slice(0, 160), summary: text.length > 160 ? text : undefined,
        props: { decision: true, decidedIn: input.title.slice(0, 200), ...(info.tookPlace ? { decidedAt: info.tookPlace } : {}) },
        visibility: input.visibility, note: `Decided in “${input.title}”.`, receipt,
      });
      counts.other++;
    }
    addEdge(input.eventNodeId, "about", topicId, receipt, 0.85, "Decided in the meeting.");
  }

  // Open to-dos: reminders (with Record's day when it gave one).
  const now = input.now ?? new Date();
  for (const t of info.todos.filter((x) => !x.done).slice(0, 40)) {
    const i = bestLine(t.text, lines);
    const due = t.due && /^\d{4}-\d{2}-\d{2}$/.test(t.due) ? new Date(`${t.due}T08:00:00.000Z`) : new Date(now.getTime() + 7 * 86_400_000);
    const owner = t.owner ? seen.get(norm(t.owner)) ?? matchKnownPerson(t.owner, [...people, ...proposedPeople])?.id ?? null : null;
    changes.push({
      op: "addReminder", title: (t.owner ? `${t.owner}: ${t.text}` : t.text).slice(0, 200), dueAt: due.toISOString(), aboutNodeId: owner,
      detail: `From the meeting “${input.title}”.${t.due ? "" : " Record gave no day; change it when you approve it."}`,
      note: "A to-do from the meeting.", receipt: momentReceipt(input.sourceId, info, lines[i] ?? first, i >= 0 ? lines[i].text : t.text, 0.85),
    });
    counts.reminders++;
  }
  const edgeKeys = changes.flatMap((c) => (c.op === "addEdge" ? [edgeKey(c.fromId, c.relation, c.toId)] : []));
  return { changes, known: [...knownMore, ...proposedPeople], edgeKeys, counts };
}
