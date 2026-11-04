/**
 * What a plugin's RECORD becomes (pure): a source with provenance (kind connector, url, externalId, connectionId,
 * fetchedAt), deduplicated by the plugin, stream and key; and, for event streams, a proposed timeline event (a change
 * set the person delivers). Outside text is data: titles and texts are stored as they came, never acted on.
 */
import { createHash } from "node:crypto";
import type { MapKind, RecordData } from "./protocol";

export const externalIdOf = (pluginId: string, stream: string, key: string) => `plugin:${pluginId}:${stream}:${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;

/** A stable fingerprint of what the record says (a changed item updates its source; an unchanged one is skipped). */
export function fingerprint(d: RecordData): string {
  const keys = Object.keys(d).sort();
  return createHash("sha256").update(JSON.stringify(d, keys)).digest("hex").slice(0, 32);
}

const date = (s: string | undefined) => { if (!s) return null; const d = new Date(s); return Number.isNaN(d.getTime()) ? null : d; };

/** A web address worth keeping: http(s) only (a record can't smuggle javascript: or file: links into the library). */
export function safeUrl(u: string | undefined): string | null {
  if (!u) return null;
  try { const x = new URL(u); return x.protocol === "https:" || x.protocol === "http:" ? x.toString().slice(0, 2000) : null; } catch { return null; }
}

export type SourceValues = {
  title: string; textContent: string; mime: string; url: string | null; documentDate: Date | null; documentDatePrecision: "minute" | "day" | null;
  externalId: string; meta: Record<string, unknown>;
};

export function sourceFor(input: { pluginId: string; pluginName: string; stream: string; maps: MapKind; key: string; data: RecordData; fetchedAt: Date }): SourceValues {
  const d = input.data;
  const when = date(d.start) ?? date(d.date);
  const lines = [d.title, d.author ? `From: ${d.author}` : "", d.location ? `Where: ${d.location}` : "", d.start ? `When: ${d.start}${d.end ? ` to ${d.end}` : ""}` : "", d.url ? `Link: ${d.url}` : "", "", d.text ?? ""];
  return {
    title: d.title.replace(/\s+/g, " ").trim().slice(0, 250),
    textContent: lines.filter((l, i) => l || i === 5).join("\n").trim().slice(0, 200_000),
    mime: d.mime?.slice(0, 100) || "text/plain",
    url: safeUrl(d.url),
    documentDate: when,
    documentDatePrecision: when ? (d.allDay ? "day" : "minute") : null,
    externalId: externalIdOf(input.pluginId, input.stream, input.key),
    meta: {
      kind: "plugin_record", plugin: input.pluginId, pluginName: input.pluginName, stream: input.stream, maps: input.maps, key: input.key.slice(0, 500),
      fingerprint: fingerprint(d), seenAt: input.fetchedAt.toISOString(),
      ...(d.author ? { author: d.author.slice(0, 200) } : {}),
      ...(input.maps === "event" ? { start: d.start ?? null, end: d.end ?? null, allDay: !!d.allDay, location: d.location ?? null } : {}),
    },
  };
}

/** A proposed event for an event record: an addNode with the id kept on the source, so a later change updates it. */
export function eventChange(input: { data: RecordData; sourceId: string; nodeId: string; nodeExists: boolean; visibility: "private" | "parents" | "household"; label: string; personNodeId?: string | null }) {
  const d = input.data;
  const start = date(d.start) ?? date(d.date);
  if (!start) return [];
  const receipt = { sourceId: input.sourceId, quote: d.title.slice(0, 300), ...(safeUrl(d.url) ? { url: safeUrl(d.url)! } : {}), confidence: 0.9 };
  const props: Record<string, unknown> = { ...(d.location ? { location: d.location } : {}), ...(d.allDay ? { allDay: true } : {}), ...(safeUrl(d.url) ? { url: safeUrl(d.url) } : {}) };
  const note = `From ${input.label}.`;
  if (input.nodeExists) {
    return [{ op: "updateNode" as const, nodeId: input.nodeId, set: { label: d.title.slice(0, 200), startAt: start.toISOString(), endAt: date(d.end)?.toISOString() ?? null, props }, note: `${note} It changed at the source.`, receipt }];
  }
  return [
    { op: "addNode" as const, nodeId: input.nodeId, type: "event", label: d.title.slice(0, 200), summary: d.text ? d.text.replace(/\s+/g, " ").slice(0, 400) : undefined, props, startAt: start.toISOString(), endAt: date(d.end)?.toISOString() ?? null, visibility: input.visibility, note, receipt },
    ...(input.personNodeId ? [{ op: "addEdge" as const, fromId: input.nodeId, toId: input.personNodeId, relation: "involves", status: "unconfirmed" as const, confidence: 0.8, note, receipt }] : []),
  ];
}

/** Collect every string value of a JSON settings object (to redact secrets from logs). */
export function stringLeaves(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") { if (v.length >= 4) out.push(v); }
  else if (Array.isArray(v)) v.forEach((x) => stringLeaves(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => stringLeaves(x, out));
  return out;
}

export function redactAll(text: string, secrets: string[]): string {
  let t = text;
  for (const s of secrets) if (s) t = t.split(s).join("•••");
  return t;
}
