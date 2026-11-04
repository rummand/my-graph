/**
 * Turn what the model read in a document into proposed changes (a change set) instead of writing them into the graph.
 * Pure: the caller loads what the graph already knows and mints ids; this decides which ops are new, each with a
 * receipt pointing at the passage it came from. Running it again over the same document and a graph that already
 * holds the result proposes nothing (idempotent).
 */
import type { ChangeInput, Receipt } from "@/lib/changes";
import type { Locator } from "@/db/schema";
import { clampConfidence, edgeStatusFor, findQuoteChunk, matchKnownPerson, reminderDueAt, type Extraction } from "./extraction";
import { displayName, type Participant } from "./mail";

export type KnownNode = { id: string; type: string; label: string; aliases: string[]; startAt?: string | null; email?: string | null };
export type ChunkRef = { id: string; idx: number; text: string; locator: Locator };
export type Group = { ex: Extraction; chunks: ChunkRef[] };

export type ProposalPlan = {
  changes: ChangeInput[];
  counts: { people: number; events: number; other: number; connections: number; reminders: number; dropped: number };
};

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const day = (iso: string | Date | null | undefined) => (iso ? new Date(iso).toISOString().slice(0, 10) : null);
export const edgeKey = (from: string, relation: string, to: string) => `${from}|${relation}|${to}`;

/** A short passage around the first mention of `label`, for a receipt's quote. */
export function passageAround(text: string, label: string, max = 180): string {
  const i = norm(text).indexOf(norm(label));
  if (i < 0) return text.slice(0, max).trim();
  const start = Math.max(0, i - 60);
  const s = text.slice(start, start + max).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${s}${start + max < text.length ? "…" : ""}`;
}

export function buildProposalOps(input: {
  groups: Group[];
  known: KnownNode[];
  sourceId: string;
  docNodeId: string | null;
  existingEdges: ReadonlySet<string>;
  visibility: "private" | "parents" | "household";
  /** People who get reminders for their upcoming events (children in a family graph): node id → name. */
  remindFor?: ReadonlyMap<string, string>;
  now?: Date;
  mint: () => string;
  sourceTitle: string;
}): ProposalPlan {
  const now = input.now ?? new Date();
  const changes: ChangeInput[] = [];
  const counts = { people: 0, events: 0, other: 0, connections: 0, reminders: 0, dropped: 0 };
  const people = input.known.filter((k) => k.type === "person");
  const byTypeLabel = new Map<string, KnownNode>();
  for (const k of input.known) {
    byTypeLabel.set(`${k.type}:${norm(k.label)}`, k);
    for (const a of k.aliases) byTypeLabel.set(`${k.type}:${norm(a)}`, k);
  }
  const labelToId = new Map<string, string>();
  const typeOf = new Map<string, string>();
  for (const k of input.known) typeOf.set(k.id, k.type);
  const edges = new Set(input.existingEdges);
  const proposedEdges = new Set<string>();
  const events = new Map<string, { label: string; startAt: Date; personIds: Set<string> }>();

  const receipt = (chunk: ChunkRef | undefined, quote: string | null | undefined, confidence: number): Receipt => ({
    sourceId: input.sourceId, chunkId: chunk?.id, locator: chunk?.locator ?? {}, quote: quote ?? undefined, confidence,
  });
  const addEdge = (fromId: string, relation: string, toId: string, r: Receipt, confidence: number, note: string) => {
    const k = edgeKey(fromId, relation, toId);
    if (edges.has(k) || proposedEdges.has(k)) return false;
    proposedEdges.add(k);
    changes.push({ op: "addEdge", fromId, toId, relation, confidence, status: edgeStatusFor(confidence), note, receipt: r });
    return true;
  };

  for (const { ex, chunks } of input.groups) {
    counts.dropped += ex.dropped;
    const chunkMentioning = (label: string) => chunks.find((c) => norm(c.text).includes(norm(label))) ?? chunks[0];

    for (const ent of ex.entities) {
      const key = norm(ent.label);
      let id = labelToId.get(key);
      if (!id && ent.type === "person") id = matchKnownPerson(ent.label, people)?.id;
      if (!id) {
        const hit = byTypeLabel.get(`${ent.type}:${key}`) ?? ent.aliases.map((a) => byTypeLabel.get(`${ent.type}:${norm(a)}`)).find(Boolean);
        // An event with the same name on another day is another event.
        if (hit && !(ent.type === "event" && ent.startAt && hit.startAt && day(hit.startAt) !== day(ent.startAt))) id = hit.id;
      }
      const chunk = chunkMentioning(ent.label);
      if (!id) {
        id = input.mint();
        changes.push({
          op: "addNode", nodeId: id, type: ent.type, label: ent.label, summary: ent.summary, aliases: ent.aliases,
          startAt: ent.startAt?.toISOString() ?? null, endAt: ent.endAt?.toISOString() ?? null, visibility: input.visibility,
          note: `Named in “${input.sourceTitle}”.`,
          receipt: receipt(chunk, passageAround(chunk?.text ?? "", ent.label), 0.8),
        });
        if (ent.type === "person") counts.people++;
        else if (ent.type === "event") counts.events++;
        else counts.other++;
        byTypeLabel.set(`${ent.type}:${key}`, { id, type: ent.type, label: ent.label, aliases: ent.aliases, startAt: ent.startAt?.toISOString() ?? null });
      }
      labelToId.set(key, id);
      for (const a of ent.aliases) labelToId.set(norm(a), id);
      typeOf.set(id, ent.type);
      if (ent.type === "event" && ent.startAt && !events.has(id)) events.set(id, { label: ent.label, startAt: ent.startAt, personIds: new Set() });
      if (input.docNodeId) addEdge(input.docNodeId, "mentions", id, receipt(chunk, null, 0.95), 0.95, "The document names it.");
    }

    const resolve = (label: string) => labelToId.get(norm(label)) ?? matchKnownPerson(label, people)?.id;
    for (const f of ex.facts) {
      let fromId = resolve(f.from);
      let toId = resolve(f.to);
      if (!fromId || !toId || fromId === toId) { counts.dropped++; continue; }
      if (f.relation === "involves" && typeOf.get(fromId) === "person" && typeOf.get(toId) === "event") [fromId, toId] = [toId, fromId];
      const confidence = clampConfidence(f.confidence);
      const chunk = findQuoteChunk(f.quote, chunks) ?? chunks[0];
      if (addEdge(fromId, f.relation, toId, receipt(chunk, f.quote ?? null, confidence), confidence, f.quote ? "Stated in the document." : "Read from the document.")) counts.connections++;
      if (f.relation === "involves" && events.has(fromId) && typeOf.get(toId) === "person") events.get(fromId)!.personIds.add(toId);
    }
  }

  // Reminders for upcoming events of the people who get them.
  if (input.remindFor?.size) {
    for (const ev of events.values()) {
      for (const pid of ev.personIds) {
        const name = input.remindFor.get(pid);
        if (!name) continue;
        const dueAt = reminderDueAt(ev.startAt, now);
        if (!dueAt) continue;
        changes.push({
          op: "addReminder", title: `${name}: ${ev.label}`, dueAt: dueAt.toISOString(), aboutNodeId: pid,
          detail: `Coming up on ${ev.startAt.toISOString().slice(0, 10)}. Found in “${input.sourceTitle}”.`,
          note: `So ${name}'s ${ev.label} isn't missed.`, receipt: { sourceId: input.sourceId, confidence: 0.8 },
        });
        counts.reminders++;
      }
    }
  }
  return { changes, counts };
}

/** Correspondents nobody in the graph matches yet, proposed as people (with their email address). */
export function correspondentOps(input: {
  participants: Participant[];
  known: KnownNode[];
  /** Emails that belong to people already (members' logins, people's props.email), lower-cased. */
  knownEmails: ReadonlySet<string>;
  /** Emails already waiting in an open proposal. */
  pendingEmails: ReadonlySet<string>;
  sourceId: string;
  header: string;
  mint: () => string;
}): ChangeInput[] {
  const people = input.known.filter((k) => k.type === "person");
  const out: ChangeInput[] = [];
  const seen = new Set<string>();
  for (const p of input.participants) {
    const email = p.email.toLowerCase();
    if (input.knownEmails.has(email) || input.pendingEmails.has(email) || seen.has(email)) continue;
    if (people.some((k) => (k.email ?? "").toLowerCase() === email)) continue;
    if (p.name && matchKnownPerson(p.name, people)) continue;
    if (/^(no-?reply|noreply|do-?not-?reply|mailer-daemon|postmaster)@/i.test(email)) continue;
    seen.add(email);
    out.push({
      op: "addNode", nodeId: input.mint(), type: "person", label: displayName(p), props: { email }, aliases: [],
      note: p.role === "from" ? "Wrote to you." : "Was on the conversation.",
      receipt: { sourceId: input.sourceId, quote: input.header.slice(0, 200), confidence: 0.9 },
    });
  }
  return out;
}

/** "2 people, 1 date and 3 connections" for a change set's title or a library line. */
export function describeCounts(c: Partial<ProposalPlan["counts"]>): string {
  const parts = [
    c.people ? `${c.people} ${c.people === 1 ? "person" : "people"}` : null,
    c.events ? `${c.events} ${c.events === 1 ? "date" : "dates"}` : null,
    c.other ? `${c.other} ${c.other === 1 ? "place or topic" : "places and topics"}` : null,
    c.connections ? `${c.connections} ${c.connections === 1 ? "connection" : "connections"}` : null,
    c.reminders ? `${c.reminders} ${c.reminders === 1 ? "reminder" : "reminders"}` : null,
  ].filter(Boolean) as string[];
  if (!parts.length) return "nothing new";
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
}
