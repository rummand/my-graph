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
import { itemLevel, maxLevel } from "./sensitivity";
import { ALL_ON, flagsFrom, offWords, type RetrievalFlags } from "./steps";
import type { PersonRef } from "./clarify";

export { ALL_ON, flagsFrom, offWords };

export type Retrieval = { items: ContextItem[]; hits: number; people: PersonRef[]; mentioned?: gbrain.GNode[] };

/** The question with @[Label](node:id) mentions reduced to their labels (what the search engine should see). */
export function plainQuestion(question: string): string {
  return question.replace(/@\[([^\]]+)\]\(node:[0-9a-f-]{36}\)/gi, "$1");
}

/**
 * Questions about time ("when", "next week", "what's new", "hvornår", "i morgen") get the full list of what's coming
 * up; any other question gets the nearest few, so unrelated dates don't crowd the context.
 */
export const TIME_WORDS = /(?<![\p{L}\p{N}])(when|next|upcoming|coming|soon|today|tonight|tomorrow|week|weekend|month|plans?|schedule|calendar|agenda|due|deadline|new|latest|happening|hvorn[åa]r|n[æa]ste|kommende|snart|i dag|i aften|i morgen|uge\p{L}*|weekend\p{L}*|m[åa]ned\p{L}*|plan\p{L}*|kalender\p{L}*|frist\p{L}*|nyt|nye|seneste|sker)(?![\p{L}\p{N}])/iu;

export const isTimeQuestion = (q: string) => TIME_WORDS.test(q);

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

/** Props that are bookkeeping, not knowledge: ids, flags and file types the model can't use (and that cost tokens). */
const SYSTEM_PROP = /^(self|kind|mime|mimeType|householdMember|household_member|hash|checksum|url|href|.*(?:Id|_id|Ids|_ids))$/;
const ID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function nodeText(n: Pick<gbrain.GNode, "summary" | "props">): string {
  const props = Object.entries(n.props ?? {})
    .filter(([k, v]) => !SYSTEM_PROP.test(k) && !(typeof v === "string" && ID_LIKE.test(v)))
    .filter(([, v]) => v !== null && v !== "" && (typeof v === "string" || typeof v === "number" || typeof v === "boolean"))
    .slice(0, 8)
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`);
  return [n.summary ?? "", props.join("; ")].filter(Boolean).join(" — ");
}

function nodeItem(n: gbrain.GNode, tz: string, viewerId: string): ContextItem {
  return {
    kind: "node", nodeId: n.id, nodeType: n.type, title: n.label, text: nodeText(n),
    when: n.startAt ? whenLabel(n.startAt, tz, n.timePrecision) : null, sensitive: n.sensitive,
    level: itemLevel(n, viewerId),
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

/**
 * `mentionIds`: nodes the person @mentioned (already checked readable by resolveMentions). They come first, as if
 * they were the best hits, and their neighbourhoods are always looked at.
 */
export async function retrieve(v: Viewer, rawQuestion: string, opts: { tz: string; now?: Date; flags?: RetrievalFlags; mentionIds?: string[] }): Promise<Retrieval> {
  const question = plainQuestion(rawQuestion);
  const now = opts.now ?? new Date();
  const tz = opts.tz;
  const flags = opts.flags ?? ALL_ON;
  const noEvents = { events: [] as gbrain.GNode[], involves: [] as { eventId: string; personId: string }[] };
  const mentionIds = [...new Set(opts.mentionIds ?? [])].slice(0, 8);
  const upcomingLimit = isTimeQuestion(question) ? 12 : 4;
  const [searchHits, meta, upcoming, reminders, mentionedRaw] = await Promise.all([
    safe(gbrain.search(v, question, { limit: 12, relevant: true }), [], "search"),
    safe(getMeta(v), null, "meta"),
    flags.timeline ? safe(gbrain.timeline(v, { from: now, to: new Date(now.getTime() + 14 * 86_400_000), limit: upcomingLimit }), noEvents, "timeline") : Promise.resolve(noEvents),
    flags.reminders ? safe(listReminders(v, { upcoming: true, days: 21, limit: upcomingLimit, now }), [], "reminders") : Promise.resolve([]),
    Promise.all(mentionIds.map((id) => safe(gbrain.getNode(v, id), null, "mentioned node"))),
  ]);
  const mentioned = mentionedRaw.filter((n): n is gbrain.GNode => !!n);
  const rawHits: gbrain.SearchHit[] = [
    ...mentioned.map((node) => ({ kind: "node" as const, score: 1, node })),
    ...searchHits.filter((h) => !(h.node && mentioned.some((m) => m.id === h.node!.id))),
  ];
  // Library off: no document passages or document nodes.
  const hits = flags.library ? rawHits : rawHits.filter((h) => !h.chunk && h.node && h.node.type !== "document" && h.node.type !== "source");

  // Sources behind passage hits: how restricted are they?
  const chunkSourceIds = [...new Set(hits.filter((h) => h.chunk).map((h) => h.chunk!.sourceId))];
  const sensitiveSources = new Set<string>();
  const webSources = new Set<string>();
  const sourceLevel = new Map<string, ReturnType<typeof itemLevel>>();
  if (chunkSourceIds.length) {
    const rows = await safe(db.select({ id: sources.id, sensitive: sources.sensitive, visibility: sources.visibility, ownerId: sources.ownerId, kind: sources.kind }).from(sources).where(inArray(sources.id, chunkSourceIds)), [], "source flags");
    for (const r of rows) {
      if (r.sensitive) sensitiveSources.add(r.id);
      if (r.kind === "web") webSources.add(r.id);
      sourceLevel.set(r.id, itemLevel(r, v.id));
    }
  }

  // Neighbourhoods of the top people / events / places among the hits.
  const centres = [
    ...mentioned,
    ...hits.filter((h) => h.node && !mentioned.some((m) => m.id === h.node!.id) && ["person", "event", "place", "topic", "organization", "project"].includes(h.node.type)).slice(0, NEIGHBOUR_HITS).map((h) => h.node!),
  ].slice(0, NEIGHBOUR_HITS + mentioned.length);
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
  const peopleText = flags.people && people.length ? await safe(peopleContext(v, people.map((p) => p.id), { now }), "", "people context") : "";
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
        kind: "passage", sourceId: h.chunk.sourceId, title: webSources.has(h.chunk.sourceId) ? `Web page: ${h.chunk.sourceTitle}` : h.chunk.sourceTitle, text: h.chunk.text,
        locator: h.chunk.locator ?? {}, sensitive: sensitiveSources.has(h.chunk.sourceId),
        level: sourceLevel.get(h.chunk.sourceId) ?? "normal",
      });
    } else if (h.node) {
      items.push(withPerson(nodeItem(h.node, tz, v.id)));
    }
  }
  // People around the top hits that weren't hits themselves, when there is something to say about them.
  for (const p of people) {
    if (personLines.has(p.id) && !items.some((i) => i.kind === "node" && i.nodeId === p.id)) items.push(withPerson(nodeItem(p, tz, v.id)));
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
      level: maxLevel([itemLevel(e, v.id), itemLevel(from, v.id), itemLevel(to, v.id)]),
    });
  }
  // 3. What's coming up.
  for (const ev of upcoming.events) items.push(nodeItem(ev, tz, v.id));
  for (const r of reminders) {
    items.push({
      kind: "reminder", title: r.title, due: whenLabel(new Date(r.dueAt), tz), about: r.aboutLabel,
      nodeId: r.aboutNodeId ?? r.nodeId, sourceId: r.sourceId, sensitive: false, level: "normal",
    });
  }
  // Everyone the viewer can see who came up, for "which Emma?" (people the search found by name).
  const personRefs = [...nodeById.values()].filter((n) => n.type === "person").map((n) => ({ id: n.id, label: n.label, kind: n.kind ?? null }));
  return { items, hits: hits.filter((h) => !(h.node && mentioned.some((m) => m.id === h.node!.id))).length, people: personRefs, mentioned };
}

/** For the degraded answer (mux down): the best few items as a plain list. */
export function topItemsForFallback(items: ContextItem[], n = 5): ContextItem[] {
  return items.filter((i) => i.kind === "passage" || i.kind === "node" || i.kind === "fact").slice(0, n);
}
