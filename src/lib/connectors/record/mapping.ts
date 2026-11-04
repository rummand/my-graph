/**
 * A meeting from Record, as My Graph keeps it (pure). Record's MCP tools answer JSON (`structuredContent`); this turns
 * them into one recording source (title, link, the day it was recorded, the transcript as text with a time per line)
 * and the time line the player follows (words with their moments, lines, speakers).
 *
 * Shapes read (Record's MCP server, docs/API.md "The MCP server"):
 *   list_meetings  → { meetings: [{ id, workspace, title, tookPlace, durationMs, status, summary, link, updatedAt? }] }
 *   get_meeting    → { id, title, tookPlace, durationMs, link, status, recordedBy, people: [string], tags: [string],
 *                      summary, decisions: [string], sections, todos: [{ id, text, owner, due, done }],
 *                      transcript: "[m:ss] Speaker: words\n…" }
 *   get_meeting_timeline (new) → { id?, durationMs, words: [{ a, b, w, line }],
 *                      lines: [{ a, b, speaker, first, last, seq? }], speakers?: [{ key?, name, email? }] }
 *   get_meeting_audio (new)    → { url, expiresAt, mimeType?, durationMs?, peaks?: number[] | { peaks: number[] } }
 * Anything missing is tolerated: without a time line, word times are spread over each transcript line ("estimated").
 */
import { createHash } from "node:crypto";

export type MeetingListItem = {
  id: string; title: string; tookPlace: string | null; durationMs: number; status: string | null; summary: string | null;
  link: string | null; workspace: string | null; updatedAt: string | null;
};

export type MeetingTodo = { id: string | null; text: string; owner: string | null; due: string | null; done: boolean };

export type MeetingDetail = MeetingListItem & {
  recordedBy: string | null; people: string[]; tags: string[]; decisions: string[]; todos: MeetingTodo[];
  sections: { title: string; text: string }[]; transcript: string;
};

export type TimelineWord = { a: number; b: number; w: string; line: number };
export type TimelineLine = { a: number; b: number; speaker: string | null; first: number; last: number; text: string };
export type TimelineSpeaker = { key: string; name: string; email: string | null };
export type Timeline = { durationMs: number; words: TimelineWord[]; lines: TimelineLine[]; speakers: TimelineSpeaker[]; timing: "exact" | "estimated" };

const s = (v: unknown, max = 2000): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0);
const iso = (v: unknown): string | null => {
  const t = s(v, 60);
  if (!t) return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
/** Only http(s) links are kept (a link is shown to people and opened in a new tab). */
const httpLink = (v: unknown): string | null => {
  const t = s(v, 2000);
  if (!t) return null;
  try {
    const u = new URL(t);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
};

export function meetingFromList(raw: unknown): MeetingListItem | null {
  const m = (raw ?? {}) as Record<string, unknown>;
  const id = s(m.id, 120);
  if (!id || !/^[A-Za-z0-9_.:-]+$/.test(id)) return null;
  return {
    id, title: s(m.title, 250) ?? "Untitled meeting", tookPlace: iso(m.tookPlace ?? m.took_place ?? m.startedAt), durationMs: n(m.durationMs),
    status: s(m.status, 80), summary: s(m.summary, 4000), link: httpLink(m.link ?? m.href), workspace: s(m.workspace, 200),
    updatedAt: iso(m.updatedAt ?? m.updated_at),
  };
}

export function meetingsFromList(result: unknown): MeetingListItem[] {
  const list = (result as { meetings?: unknown[] } | null)?.meetings;
  return Array.isArray(list) ? list.map(meetingFromList).filter((m): m is MeetingListItem => !!m) : [];
}

export function meetingDetail(raw: unknown, fallback?: MeetingListItem): MeetingDetail | null {
  const base = meetingFromList(raw) ?? fallback ?? null;
  if (!base) return null;
  const m = (raw ?? {}) as Record<string, unknown>;
  const strings = (v: unknown, max = 500) => (Array.isArray(v) ? v.map((x) => s(typeof x === "object" && x ? (x as { name?: unknown; text?: unknown }).name ?? (x as { text?: unknown }).text : x, max)).filter((x): x is string => !!x) : []);
  const todos: MeetingTodo[] = Array.isArray(m.todos) ? m.todos.flatMap((t) => {
    const x = (t ?? {}) as Record<string, unknown>;
    const text = s(x.text, 500);
    return text ? [{ id: s(x.id, 120), text, owner: s(x.owner, 120), due: /^\d{4}-\d{2}-\d{2}/.test(String(x.due ?? "")) ? String(x.due).slice(0, 10) : null, done: x.done === true }] : [];
  }) : [];
  const sections = Array.isArray(m.sections) ? m.sections.flatMap((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    const text = s(o.text ?? o.body, 4000);
    return text ? [{ title: s(o.title ?? o.heading, 200) ?? "", text }] : [];
  }) : [];
  return {
    ...base,
    summary: s(m.summary, 8000) ?? base.summary,
    recordedBy: s(m.recordedBy, 120), people: strings(m.people, 120).slice(0, 100), tags: strings(m.tags, 80).slice(0, 50),
    decisions: strings(m.decisions, 1000).slice(0, 100), todos: todos.slice(0, 200), sections: sections.slice(0, 50),
    transcript: typeof m.transcript === "string" ? m.transcript.slice(0, 2_000_000) : "",
  };
}

/* ── Transcript text ↔ lines ─────────────────────────────────────────────────────────────────────────── */

/** "1:02:03" / "4:05" / "05" → ms. */
export function stampMs(stamp: string): number | null {
  const parts = stamp.trim().split(":").map((p) => Number(p));
  if (!parts.length || parts.some((p) => !Number.isFinite(p) || p < 0)) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0) * 1000;
}

export function msStamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), sec = total % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

/** `[m:ss] Speaker: words` lines (Record's transcript) → lines with start times; untimed lines join the one before. */
export function parseTranscript(text: string, durationMs = 0): { a: number; b: number; speaker: string | null; text: string }[] {
  const out: { a: number; b: number; speaker: string | null; text: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^\[(\d{1,2}(?::\d{1,2}){1,2})\]\s*(.*)$/);
    if (!m) {
      if (out.length) out[out.length - 1].text += ` ${line}`;
      else out.push({ a: 0, b: 0, speaker: null, text: line });
      continue;
    }
    const a = stampMs(m[1]) ?? 0;
    const rest = m[2];
    // "Speaker: words" — a speaker is short and has no sentence punctuation before the colon.
    const sp = rest.match(/^([^:.!?\n]{1,60}):\s+(.*)$/);
    out.push({ a, b: 0, speaker: sp ? sp[1].trim() : null, text: (sp ? sp[2] : rest).trim() });
  }
  for (let i = 0; i < out.length; i++) {
    const next = out[i + 1]?.a;
    const end = next !== undefined && next > out[i].a ? next : Math.max(durationMs, out[i].a + Math.max(1500, out[i].text.length * 60));
    out[i].b = end;
  }
  return out.filter((l) => l.text);
}

/** Spread each line's words over its time, by length (a word's share of the line's characters). */
export function estimateWords(lines: { a: number; b: number; text: string }[]): TimelineWord[] {
  const words: TimelineWord[] = [];
  lines.forEach((l, li) => {
    const ws = l.text.split(/\s+/).filter(Boolean);
    const total = ws.reduce((t, w) => t + w.length + 1, 0) || 1;
    let at = l.a;
    const span = Math.max(0, l.b - l.a);
    for (const w of ws) {
      const d = Math.max(1, Math.round((span * (w.length + 1)) / total));
      words.push({ a: at, b: Math.min(l.b, at + d), w, line: li });
      at += d;
    }
  });
  return words;
}

function speakerName(v: unknown, speakers: TimelineSpeaker[]): string | null {
  if (typeof v === "string") return v.trim().slice(0, 120) || null;
  if (typeof v === "number") return speakers[v]?.name ?? null;
  if (v && typeof v === "object") return s((v as { name?: unknown }).name, 120);
  return null;
}

export function speakersFrom(raw: unknown): TimelineSpeaker[] {
  if (!Array.isArray(raw)) return [];
  const out: TimelineSpeaker[] = [];
  for (const x of raw) {
    const o = (typeof x === "string" ? { name: x } : x ?? {}) as Record<string, unknown>;
    const name = s(o.name ?? o.label, 120);
    if (!name) continue;
    const email = s(o.email, 320);
    out.push({ key: s(o.key ?? o.id, 120) ?? name, name, email: email && /@/.test(email) ? email.toLowerCase() : null });
  }
  return out;
}

/** get_meeting_timeline's answer → our time line ("exact"), or null when it has no words. */
export function timelineFrom(raw: unknown): Timeline | null {
  const t = (raw ?? {}) as { durationMs?: unknown; words?: unknown[]; lines?: unknown[]; speakers?: unknown; timeline?: unknown };
  if (t.timeline && typeof t.timeline === "object" && !t.words) return timelineFrom({ ...(t.timeline as object), speakers: t.speakers });
  if (!Array.isArray(t.words) || !t.words.length) return null;
  const speakers = speakersFrom(t.speakers);
  const words: TimelineWord[] = t.words.slice(0, 200_000).flatMap((x) => {
    const w = (x ?? {}) as Record<string, unknown>;
    const text = typeof w.w === "string" ? w.w : typeof w.word === "string" ? w.word : null;
    return text ? [{ a: n(w.a), b: Math.max(n(w.a), n(w.b)), w: text.slice(0, 100), line: n(w.line) }] : [];
  });
  const rawLines = Array.isArray(t.lines) ? t.lines : [];
  const lines: TimelineLine[] = rawLines.map((x, i) => {
    const l = (x ?? {}) as Record<string, unknown>;
    let first = Number.isFinite(Number(l.first)) ? n(l.first) : words.findIndex((w) => w.line === i);
    let last = Number.isFinite(Number(l.last)) ? n(l.last) : words.map((w) => w.line).lastIndexOf(i);
    if (first < 0) first = 0;
    if (last < first) last = first;
    return {
      a: n(l.a), b: Math.max(n(l.a), n(l.b)), speaker: speakerName(l.speaker, speakers), first, last,
      text: words.slice(first, last + 1).map((w) => w.w).join(" "),
    };
  });
  // Words name their line by index; keep that consistent with what we kept.
  for (const [li, l] of lines.entries()) for (let i = l.first; i <= l.last && i < words.length; i++) words[i].line = li;
  const named = new Set(speakers.map((sp) => sp.name.toLowerCase()));
  for (const l of lines) if (l.speaker && !named.has(l.speaker.toLowerCase())) { named.add(l.speaker.toLowerCase()); speakers.push({ key: l.speaker, name: l.speaker, email: null }); }
  const durationMs = Math.max(n(t.durationMs), words.at(-1)?.b ?? 0, lines.at(-1)?.b ?? 0);
  return { durationMs, words, lines, speakers, timing: "exact" };
}

/** A time line from the plain transcript (no word times from the server): every word's moment is estimated. */
export function timelineFromTranscript(transcript: string, durationMs: number, people: string[] = []): Timeline {
  const parsed = parseTranscript(transcript, durationMs);
  const words = estimateWords(parsed);
  const lines: TimelineLine[] = parsed.map((l, li) => {
    const first = words.findIndex((w) => w.line === li);
    const last = words.map((w) => w.line).lastIndexOf(li);
    return { a: l.a, b: l.b, speaker: l.speaker, first: Math.max(0, first), last: Math.max(0, last), text: l.text };
  });
  const names = [...new Set([...lines.map((l) => l.speaker).filter((x): x is string => !!x), ...people])];
  return { durationMs: Math.max(durationMs, lines.at(-1)?.b ?? 0), words, lines, speakers: names.map((name) => ({ key: name, name, email: null })), timing: "estimated" };
}

/** The source's text: one line per turn, `[m:ss] Speaker: words`, the same as Record's transcript. */
export function transcriptText(lines: Pick<TimelineLine, "a" | "speaker" | "text">[]): string {
  return lines.map((l) => `[${msStamp(l.a)}] ${l.speaker ? `${l.speaker}: ` : ""}${l.text}`).join("\n");
}

/** Changes worth reading the meeting again for: words, summary, decisions, to-dos, title, status. */
export function meetingFingerprint(d: Pick<MeetingDetail, "title" | "status" | "durationMs" | "summary" | "decisions" | "todos" | "transcript" | "people">): string {
  return createHash("sha256").update(JSON.stringify([d.title, d.status, d.durationMs, d.summary, d.decisions, d.todos, d.transcript, d.people])).digest("hex").slice(0, 32);
}

/** From the list alone: has this meeting changed since we stored it? (Cheap check before asking for the whole meeting.) */
export function listFingerprint(m: MeetingListItem): string {
  return createHash("sha256").update(JSON.stringify([m.title, m.status, m.durationMs, m.summary, m.updatedAt])).digest("hex").slice(0, 32);
}

export type RecordingSourceRow = {
  externalId: string; title: string; url: string | null; documentDate: Date | null; textContent: string;
  meta: Record<string, unknown>;
};

/** A meeting → the fields of its source row (kind "recording"). Pure. */
export function meetingToSource(d: MeetingDetail, timeline: Timeline, opts: { listFingerprint: string; server: string }): RecordingSourceRow {
  const text = timeline.lines.length ? transcriptText(timeline.lines) : d.transcript;
  return {
    externalId: `record:${d.id}`,
    title: d.title.slice(0, 250),
    url: d.link,
    documentDate: d.tookPlace ? new Date(d.tookPlace) : null,
    textContent: text,
    meta: {
      kind: "recording", originalName: d.title,
      recording: {
        server: opts.server, id: d.id, link: d.link, workspace: d.workspace, status: d.status, durationMs: timeline.durationMs || d.durationMs,
        tookPlace: d.tookPlace, recordedBy: d.recordedBy, people: d.people, tags: d.tags, summary: d.summary, decisions: d.decisions,
        todos: d.todos, sections: d.sections, timing: timeline.timing, speakers: timeline.speakers,
      },
      fingerprint: meetingFingerprint(d), listFingerprint: opts.listFingerprint,
    },
  };
}
