/**
 * Retrieval for one question (server-only): hybrid search in the viewer's brain, the neighbourhood of the top people
 * and events, upcoming events and open reminders. Everything goes through GBrain / reminders with the Viewer, so the
 * assistant only ever sees what the asker may see.
 */
import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { sources } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import * as gbrain from "@/lib/gbrain";
import { listReminders } from "@/lib/briefs";
import { getMeta } from "@/lib/meta";
import { peopleContext } from "@/lib/people";
import type { ContextItem } from "./context";
import { whenLabel } from "./dates";

const NEIGHBOUR_HITS = 3;
const MAX_FACTS = 24;
const MAX_PEOPLE = 8;

/**
 * peopleContext() lines ("- Emma (child) — Your child. Wellbeing: …") keyed by person id. Lines are matched back to
 * ids by label, so a person the viewer can't see (skipped by peopleContext) simply gets no line.
 */
export function peopleLinesById(text: string, people: { id: string; label: string }[]): Map<string, string> {
  const out = new Map<string, string>();
  const lines = text.split("\n").filter((l) => l.startsWith("- "));
  const byLength = [...people].sort((a, b) => b.label.length - a.label.length);
  for (const line of lines) {
    const p = byLength.find((x) => !out.has(x.id) && (line.startsWith(`- ${x.label} (`) || line.startsWith(`- ${x.label} —`) || line === `- ${x.label}`));
    if (!p) continue;
    const i = line.indexOf(" — ");
    const body = i >= 0 ? line.slice(i + 3).trim() : "";
    if (body) out.set(p.id, body);
  }
  return out;
}

function nodeText(n: gbrain.GNode): string {
  const props = Object.entries(n.props ?? {})
    .filter(([, v]) => v !== null && v !== "" && (typeof v === "string" || typeof v === "number" || typeof v === "boolean"))
    .slice(0, 8)
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`);
  return [n.summary ?? "", props.join("; ")].filter(Boolean).join(" — ");
}

function nodeItem(n: gbrain.GNode, tz: string): ContextItem {
  return {
    kind: "node", nodeId: n.id, nodeType: n.type, title: n.label, text: nodeText(n),
    when: n.startAt ? whenLabel(n.startAt, tz, n.timePrecision) : null, sensitive: n.sensitive,
  };
}

async function safe<T>(p: Promise<T>, fallback: T, what: string): Promise<T> {
  try {
    return await p;
  } catch (e) {
    console.error(`[assistant] ${what} failed:`, e);
    return fallback;
  }
}

export async function retrieve(v: Viewer, question: string, opts: { tz: string; now?: Date }): Promise<ContextItem[]> {
  const now = opts.now ?? new Date();
  const tz = opts.tz;
  const [hits, meta, upcoming, reminders] = await Promise.all([
    safe(gbrain.search(v, question, { limit: 12 }), [], "search"),
    safe(getMeta(v), null, "meta"),
    safe(gbrain.timeline(v, { from: now, to: new Date(now.getTime() + 14 * 86_400_000), limit: 12 }), { events: [], involves: [] }, "timeline"),
    safe(listReminders(v, { upcoming: true, days: 21, limit: 12, now }), [], "reminders"),
  ]);

  // Sources behind passage hits: are they sensitive?
  const chunkSourceIds = [...new Set(hits.filter((h) => h.chunk).map((h) => h.chunk!.sourceId))];
  const sensitiveSources = new Set<string>();
  if (chunkSourceIds.length) {
    const rows = await safe(db.select({ id: sources.id, sensitive: sources.sensitive }).from(sources).where(inArray(sources.id, chunkSourceIds)), [], "source flags");
    for (const r of rows) if (r.sensitive) sensitiveSources.add(r.id);
  }

  // Neighbourhoods of the top people / events / places among the hits.
  const centres = hits.filter((h) => h.node && ["person", "event", "place", "topic"].includes(h.node.type)).slice(0, NEIGHBOUR_HITS).map((h) => h.node!);
  const hoods = await Promise.all(centres.map((n) => safe(gbrain.neighbourhood(v, n.id, 1), { nodes: [], edges: [] }, "neighbourhood")));
  const nodeById = new Map<string, gbrain.GNode>();
  for (const h of hoods) for (const n of h.nodes) nodeById.set(n.id, n);
  for (const h of hits) if (h.node) nodeById.set(h.node.id, h.node);
  const edgeList: gbrain.GEdge[] = [];
  const seenEdges = new Set<string>();
  for (const h of hoods) for (const e of h.edges) {
    if (seenEdges.has(e.id) || e.status === "rejected" || e.status === "superseded") continue;
    seenEdges.add(e.id);
    edgeList.push(e);
  }
  edgeList.sort((a, b) => b.confidence - a.confidence);
  const facts = edgeList.slice(0, MAX_FACTS);
  const provs = facts.length ? await safe(gbrain.explainEdges(v, facts.map((e) => e.id)), {} as Record<string, gbrain.GProvenance[]>, "explain") : {};

  // What the family brain knows about the people involved (wellbeing, last contact, birthdays), viewer-scoped.
  const people: gbrain.GNode[] = [];
  for (const n of [...hits.map((h) => h.node).filter((n): n is gbrain.GNode => !!n), ...nodeById.values()]) {
    if (n.type === "person" && !people.some((p) => p.id === n.id)) people.push(n);
    if (people.length >= MAX_PEOPLE) break;
  }
  const peopleText = people.length ? await safe(peopleContext(v, people.map((p) => p.id), { now }), "", "people context") : "";
  const personLines = peopleLinesById(peopleText, people);
  const withPerson = (it: ContextItem): ContextItem => {
    if (it.kind !== "node" || it.nodeType !== "person") return it;
    const extra = personLines.get(it.nodeId);
    return extra ? { ...it, text: [it.text, extra].filter(Boolean).join(" — ") } : it;
  };

  const label = (key: string) => meta?.relationLabel(key, "out") ?? key.replace(/_/g, " ");
  const items: ContextItem[] = [];

  // 1. Direct hits, in rank order.
  for (const h of hits) {
    if (h.chunk) {
      items.push({
        kind: "passage", sourceId: h.chunk.sourceId, title: h.chunk.sourceTitle, text: h.chunk.text,
        locator: h.chunk.locator ?? {}, sensitive: sensitiveSources.has(h.chunk.sourceId),
      });
    } else if (h.node) {
      items.push(withPerson(nodeItem(h.node, tz)));
    }
  }
  // People around the top hits that weren't hits themselves, when there is something to say about them.
  for (const p of people) {
    if (personLines.has(p.id) && !items.some((i) => i.kind === "node" && i.nodeId === p.id)) items.push(withPerson(nodeItem(p, tz)));
  }
  // 2. Facts around the top hits, with the source each came from.
  for (const e of facts) {
    const from = nodeById.get(e.fromId);
    const to = nodeById.get(e.toId);
    if (!from || !to) continue;
    const p = (provs[e.id] ?? []).find((x) => x.sourceId || x.quote) ?? provs[e.id]?.[0];
    items.push({
      kind: "fact", edgeId: e.id, fromId: e.fromId, title: `${from.label} ${label(e.relation)} ${to.label}`, status: e.status,
      confidence: e.confidence, sourceId: p?.sourceId ?? null, sourceTitle: p?.sourceTitle ?? null, quote: p?.quote ?? null,
      locator: p?.locator ?? {}, sensitive: from.sensitive || to.sensitive,
    });
  }
  // 3. What's coming up.
  for (const ev of upcoming.events) items.push(nodeItem(ev, tz));
  for (const r of reminders) {
    items.push({
      kind: "reminder", title: r.title, due: whenLabel(new Date(r.dueAt), tz), about: r.aboutLabel,
      nodeId: r.aboutNodeId ?? r.nodeId, sourceId: r.sourceId, sensitive: false,
    });
  }
  return items;
}

/** For the degraded answer (mux down): the best few items as a plain list. */
export function topItemsForFallback(items: ContextItem[], n = 5): ContextItem[] {
  return items.filter((i) => i.kind === "passage" || i.kind === "node" || i.kind === "fact").slice(0, n);
}
