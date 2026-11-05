/**
 * The watch (server-only): runs the pure checks over one graph and turns what they find into proposals.
 *
 *   clashes       → a change set with a `clashes_with` edge (both receipts, a plain sentence) per clash
 *   fulfilment    → a change set "Looks done: …" setting status done + doneAt + doneEvidenceSourceId, with the quote
 *   contradiction → advisory flags computed on read (./flags.ts); a fix is proposed only when one source clearly wins
 *
 * Agents propose, humans decide: nothing here writes to the graph. Every proposal is made as — and addressed to — the
 * person who owns the commitment (or the event), after re-checking they are still a member who may write; every read
 * is as that person (./load.ts), so nothing they couldn't open is quoted. Each finding has a stable `watchKey` in the
 * set's evidence: once proposed (delivered, waiting or dropped) it is never proposed again. No model is called.
 */
import { and, between, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { changeSets, edges, nodes, provenance, sources } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { viewerFor } from "@/lib/auth/viewer-for";
import { proposeChanges, type ChangeInput } from "@/lib/changes";
import { scopeOf } from "@/lib/graphs/pure";
import { localeOf } from "@/lib/assistant/locale";
import { loadCommitments } from "../store";
import type { CommitmentView } from "../pure";
import { COMMITMENT_RELATIONS } from "../types";
import { explainClash, findClashes, whenText, type Clash, type Slot, type WatchLocale } from "./clash";
import { explainContradiction, findContradictions } from "./contradict";
import { matchFulfilment, matchHappenedEvent, mentionsCounterparty, type Evidence, type FulfilCommitment } from "./fulfil";
import { evidenceOf, fulfilShapes, loadSlots, ownAddresses, ownSourcesOf, partiesFor, readableSource, recentSources, rulesFor, statementsFor } from "./load";
import { findAmounts, sameAmount } from "./text";

const DAY = 86_400_000;
const TZ = "Europe/Copenhagen";
const ORIGIN = "automation" as const;

/* ── Who runs it ─────────────────────────────────────────────────────────────────────────────────────── */

/** The person as a viewer in that graph, when they may still propose there (a member who may write). */
async function asOwner(userId: string, graphId: string): Promise<Viewer | null> {
  const v = await viewerFor(userId, graphId).catch(() => null);
  if (!v || v.role === "guest" || !scopeOf(v).canWrite) return null;
  return v;
}

/** Owners of open commitments in a graph (and of upcoming events, for clashes). */
async function ownersIn(graphId: string, withEvents: boolean): Promise<string[]> {
  const now = new Date();
  const rows = await db.selectDistinct({ ownerId: nodes.ownerId }).from(nodes).where(and(
    eq(nodes.graphId, graphId), isNull(nodes.mergedInto),
    or(
      and(eq(nodes.type, "commitment"), sql`coalesce(${nodes.props}->>'status', 'open') = 'open'`),
      withEvents ? and(eq(nodes.type, "event"), between(nodes.startAt, new Date(now.getTime() - DAY), new Date(now.getTime() + 60 * DAY))) : sql`false`,
    ),
  ));
  return rows.map((r) => r.ownerId);
}

/** Graphs with open commitments (the daily run). */
export async function graphsWithCommitments(): Promise<string[]> {
  const rows = await db.selectDistinct({ graphId: nodes.graphId }).from(nodes)
    .where(and(eq(nodes.type, "commitment"), isNull(nodes.mergedInto), sql`coalesce(${nodes.props}->>'status', 'open') = 'open'`));
  return rows.map((r) => r.graphId);
}

/* ── Proposing once ──────────────────────────────────────────────────────────────────────────────────── */

async function proposedBefore(graphId: string, keys: string[]): Promise<Set<string>> {
  if (!keys.length) return new Set();
  const rows = await db.select({ key: sql<string>`${changeSets.evidence}->>'watchKey'` }).from(changeSets)
    .where(and(eq(changeSets.graphId, graphId), inArray(sql`${changeSets.evidence}->>'watchKey'`, keys)));
  return new Set(rows.map((r) => r.key));
}

async function proposeOnce(v: Viewer, key: string, input: { watch: "clash" | "done" | "fix"; title: string; description: string; changes: ChangeInput[]; evidence?: Record<string, unknown> }): Promise<string | null> {
  if ((await proposedBefore(v.graphId, [key])).has(key)) return null;
  const r = await proposeChanges(v, {
    title: input.title.slice(0, 200), description: input.description.slice(0, 2000), origin: ORIGIN, forUserId: v.id,
    evidence: { ...(input.evidence ?? {}), watch: input.watch, watchKey: key } as never,
    changes: input.changes,
  });
  return r?.id ?? null;
}

/** One check per graph at a time in this process (a delivery, a source and the daily run can arrive together). */
const running = new Map<string, Promise<unknown>>();
function serial<T>(graphId: string, fn: () => Promise<T>): Promise<T> {
  const prev = running.get(graphId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  running.set(graphId, next);
  void next.finally(() => { if (running.get(graphId) === next) running.delete(graphId); }).catch(() => undefined);
  return next;
}

/* ── Clashes ─────────────────────────────────────────────────────────────────────────────────────────── */

function clashTitle(c: Clash, locale: WatchLocale): string {
  return locale === "da" ? `Overlap: „${c.a.label}“ og „${c.b.label}“` : `Clash: “${c.a.label}” and “${c.b.label}”`;
}

/** Both items' receipts: the one on the op (the first that has a source) and both in the edge's props. */
function clashReceipt(c: Clash, others: Slot[], locale: WatchLocale): { receipt: ChangeInput["receipt"]; evidence: Record<string, unknown>[] } {
  const items = [c.a, ...others];
  const evidence = items.map((s) => ({ nodeId: s.id, label: s.label, when: whenText(s, locale, TZ), sourceId: s.sourceId ?? null, quote: s.quote ?? null }));
  // The op's receipt quotes the passage the first item was read from (its own words, so it can be found again).
  const withSource = items.find((s) => s.sourceId);
  const quote = withSource ? (withSource.quote?.trim() || withSource.label) : items.map((s) => `${s.label} — ${whenText(s, locale, TZ)}`).join(" · ");
  return { receipt: { ...(withSource ? { sourceId: withSource.sourceId! } : {}), quote, confidence: c.kind === "overlap" ? 0.9 : 0.7 }, evidence };
}

/** Clash proposals for one graph. Returns how many were proposed. */
export async function checkClashes(graphId: string, now = new Date()): Promise<number> {
  return serial(graphId, async () => {
    let n = 0;
    const done = new Set<string>();
    for (const owner of await ownersIn(graphId, true)) {
      const v = await asOwner(owner, graphId);
      if (!v) continue;
      const world = await loadSlots(v, now);
      if (world.slots.length < 2) continue;
      const clashes = findClashes(world.slots, { now, tz: TZ, caretakers: world.caretakers, related: world.related });
      const locale = await localeOf(v.id) as WatchLocale;
      const nameOf = (id: string) => world.names.get(id) ?? "?";
      const keys = clashes.map((c) => c.key);
      const before = await proposedBefore(graphId, keys);
      for (const c of clashes) {
        if (before.has(c.key) || done.has(c.key)) continue;
        const pair = c.kind === "nobody_free" ? [c.a, ...(c.blockers ?? []).map((b) => b.slot)] : [c.a, c.b];
        // Proposed by whoever owns one of them, so it waits for someone it concerns; that owner's run picks it up.
        if (!pair.some((s) => s.ownerId === v.id)) continue;
        // Two calendar events from the same feed overlap all the time (work meetings); only a commitment or two
        // different sources make it a clash worth a person's attention.
        if (!pair.some((s) => s.origin === "commitment") && (!c.a.sourceId || pair.every((s) => s.sourceId === c.a.sourceId))) continue;
        const others = pair.slice(1);
        const text = explainClash(c, nameOf, locale, TZ);
        const otherLocale: WatchLocale = locale === "da" ? "en" : "da";
        const { receipt, evidence } = clashReceipt(c, others, locale);
        const ops: ChangeInput[] = others.map((o) => ({
          op: "addEdge", fromId: c.a.id, toId: o.id, relation: COMMITMENT_RELATIONS.clashesWith, confidence: c.kind === "overlap" ? 0.9 : 0.7,
          props: { watch: "clash", kind: c.kind, explanation: { [locale]: text, [otherLocale]: explainClash(c, nameOf, otherLocale, TZ) }, evidence, people: c.personIds },
          note: text, receipt,
        }));
        const id = await proposeOnce(v, c.key, { watch: "clash", title: clashTitle(c, locale), description: text, changes: ops, evidence: { nodeIds: pair.map((s) => s.id) } });
        done.add(c.key);
        if (id) n++;
      }
    }
    return n;
  });
}

/* ── Fulfilment ──────────────────────────────────────────────────────────────────────────────────────── */

function doneTitle(label: string, locale: WatchLocale): string {
  return locale === "da" ? `Ser ud til at være klaret: ${label}` : `Looks done: ${label}`;
}

function doneNote(ev: { title: string }, reasons: string[], locale: WatchLocale): string {
  const why = reasons.filter((r) => r !== "phrase");
  const words: Record<string, [string, string]> = {
    counterparty: ["names the other party", "nævner modparten"], amount: ["the amount matches", "beløbet passer"],
    thread: ["in the same conversation", "i samme samtale"], sent: ["you sent it to them", "du sendte det til dem"], event: ["it took place", "det har fundet sted"],
  };
  const parts = why.map((r) => words[r]?.[locale === "da" ? 1 : 0]).filter(Boolean);
  return locale === "da"
    ? `„${ev.title}“ ser ud til at vise, at det er gjort${parts.length ? ` (${parts.join(", ")})` : ""}. Lever for at markere det som klaret.`
    : `“${ev.title}” looks like proof it was done${parts.length ? ` (${parts.join(", ")})` : ""}. Deliver to mark it done.`;
}

/** Cheap prefilter before the full check: the other party, an amount or the thread must be there at all. */
function worthChecking(c: FulfilCommitment, ev: Evidence): boolean {
  if (ev.threadKey && c.threadKeys.includes(ev.threadKey)) return true;
  if (mentionsCounterparty(c, ev)) return true;
  if (c.amount) {
    const t = `${ev.title}\n${ev.text.slice(0, 20_000)}`;
    if (findAmounts(t).some((a) => sameAmount(a, c.amount!))) return true;
  }
  return false;
}

async function proposeDone(v: Viewer, c: FulfilCommitment, ev: { sourceId: string; title: string; docNodeId: string | null }, m: { confidence: number; quote: string; doneAt: string; reasons: string[] }, locale: WatchLocale): Promise<string | null> {
  const key = `done:${c.id}:${ev.sourceId}`;
  // One open "looks done" per commitment: a second receipt waits until the first is decided.
  const waiting = await db.select({ id: changeSets.id }).from(changeSets).where(and(
    eq(changeSets.graphId, v.graphId), eq(changeSets.status, "draft"), sql`${changeSets.evidence}->>'watchKey' like ${`done:${c.id}:%`}`)).limit(1);
  if (waiting.length) return null;
  const note = doneNote(ev, m.reasons, locale);
  const receipt = { sourceId: ev.sourceId, quote: m.quote, confidence: m.confidence };
  const ops: ChangeInput[] = [
    { op: "updateNode", nodeId: c.id, set: { props: { status: "done", doneAt: m.doneAt, doneEvidenceSourceId: ev.sourceId } }, note, receipt },
  ];
  if (ev.docNodeId) ops.push({ op: "addEdge", fromId: c.id, toId: ev.docNodeId, relation: COMMITMENT_RELATIONS.arisesFrom, confidence: m.confidence, props: { role: "done_evidence" }, note, receipt });
  return proposeOnce(v, key, { watch: "done", title: doneTitle(c.label, locale), description: note, changes: ops, evidence: { sourceId: ev.sourceId, quote: m.quote } });
}

/** Open commitments the person owns, as they see them. */
async function ownOpen(v: Viewer, ids?: string[]): Promise<CommitmentView[]> {
  const list = await loadCommitments(v, { status: ["open"], ...(ids ? { ids } : {}) });
  return list.filter((c) => c.ownerId === v.id);
}

/** After a source is read: does it show that an open commitment in its graph is done? */
export async function checkSourceForFulfilment(sourceId: string): Promise<number> {
  const [src] = await db.select({ graphId: sources.graphId }).from(sources).where(eq(sources.id, sourceId)).limit(1);
  if (!src) return 0;
  return serial(src.graphId, async () => {
    let n = 0;
    for (const owner of await ownersIn(src.graphId, false)) {
      const v = await asOwner(owner, src.graphId);
      if (!v) continue;
      const s = await readableSource(v, sourceId);
      if (!s?.textContent) continue;
      const list = await ownOpen(v);
      if (!list.length) continue;
      const ev = evidenceOf(s, await ownAddresses(v.id, v.graphId));
      const shapes = await fulfilShapes(v, list);
      const locale = await localeOf(v.id) as WatchLocale;
      // The best match only: a receipt closes one commitment, not every bill to the same payee.
      const best = shapes.filter((c) => worthChecking(c, ev)).map((c) => ({ c, m: matchFulfilment(c, ev) })).filter((x) => x.m)
        .sort((a, b) => b.m!.confidence - a.m!.confidence)[0];
      if (best && await proposeDone(v, best.c, { sourceId: s.id, title: s.title, docNodeId: s.nodeId }, best.m!, locale)) n++;
    }
    return n;
  });
}

/** New (or changed) commitments look back: did proof arrive before they were delivered? Plus appointments that happened. */
export async function checkCommitmentsAgainstRecent(graphId: string, commitmentIds: string[] | null, now = new Date()): Promise<number> {
  return serial(graphId, async () => {
    let n = 0;
    for (const owner of await ownersIn(graphId, false)) {
      const v = await asOwner(owner, graphId);
      if (!v) continue;
      const list = await ownOpen(v, commitmentIds ?? undefined);
      if (!list.length) continue;
      const shapes = await fulfilShapes(v, list);
      const locale = await localeOf(v.id) as WatchLocale;
      const own = await ownAddresses(v.id, graphId);
      const earliest = new Date(Math.min(...shapes.map((c) => c.appearedAt.getTime())) - 14 * DAY);
      const since = new Date(Math.max(earliest.getTime(), now.getTime() - 90 * DAY));
      const recent = shapes.some((c) => c.kind !== "appointment") ? await recentSources(v, since, 80) : [];
      for (const c of shapes) {
        if (c.kind === "appointment") {
          if (await appointmentHappened(v, c, now, locale)) n++;
          continue;
        }
        let best: { s: (typeof recent)[number]; m: NonNullable<ReturnType<typeof matchFulfilment>> } | null = null;
        for (const s of recent) {
          if (!s.textContent) continue;
          const ev = evidenceOf(s, own);
          if (!worthChecking(c, ev)) continue;
          const m = matchFulfilment(c, ev);
          if (m && (!best || m.confidence > best.m.confidence)) best = { s, m };
        }
        if (best && await proposeDone(v, c, { sourceId: best.s.id, title: best.s.title, docNodeId: best.s.nodeId }, best.m, locale)) n++;
      }
    }
    return n;
  });
}

/** An appointment whose day has passed and an event with the other party (not the one it came from) took place. */
async function appointmentHappened(v: Viewer, c: FulfilCommitment, now: Date, locale: WatchLocale): Promise<boolean> {
  if (!c.dueAt || c.dueAt.getTime() > now.getTime() || now.getTime() - c.dueAt.getTime() > 14 * DAY) return false;
  const { accessContext } = await import("@/lib/gbrain");
  const { nodeReadSql, liveNodeSql } = await import("@/lib/gbrain/access");
  const ctx = await accessContext(v);
  const evs = await db.select({ id: nodes.id, label: nodes.label, startAt: nodes.startAt, endAt: nodes.endAt }).from(nodes).where(and(
    eq(nodes.graphId, v.graphId), eq(nodes.type, "event"), isNull(nodes.mergedInto), liveNodeSql("nodes"), nodeReadSql(ctx, "nodes"),
    between(nodes.startAt, new Date(c.dueAt.getTime() - 12 * 3600_000), new Date(c.dueAt.getTime() + 12 * 3600_000)),
  )).limit(20);
  if (!evs.length) return false;
  // Not the event read from the same letter (that one exists from the start and proves nothing).
  const sameSource = c.ownSourceIds.length ? await db.select({ subjectId: provenance.subjectId }).from(provenance).where(and(
    eq(provenance.subjectType, "node"), inArray(provenance.subjectId, evs.map((e) => e.id)), inArray(provenance.sourceId, c.ownSourceIds))) : [];
  const skip = new Set(sameSource.map((r) => r.subjectId));
  const linked = await db.select({ fromId: edges.fromId, toId: edges.toId }).from(edges)
    .where(and(eq(edges.relation, "arises_from"), eq(edges.fromId, c.id), inArray(edges.toId, evs.map((e) => e.id))));
  linked.forEach((l) => skip.add(l.toId));
  const inv = await db.select({ fromId: edges.fromId, label: nodes.label }).from(edges).innerJoin(nodes, eq(nodes.id, edges.toId))
    .where(and(eq(edges.relation, "involves"), inArray(edges.fromId, evs.map((e) => e.id)), nodeReadSql(ctx, "nodes")));
  for (const e of evs) {
    if (skip.has(e.id) || !e.startAt) continue;
    const m = matchHappenedEvent(c, { id: e.id, label: e.label, start: e.startAt, end: e.endAt, involves: [], involvesNames: inv.filter((i) => i.fromId === e.id).map((i) => i.label) }, now);
    if (!m) continue;
    const key = `done:${c.id}:event:${e.id}`;
    const note = locale === "da" ? `„${e.label}“ har fundet sted. Lever for at markere aftalen som klaret.` : `“${e.label}” has taken place. Deliver to mark the appointment done.`;
    const id = await proposeOnce(v, key, {
      watch: "done", title: doneTitle(c.label, locale), description: note, evidence: { nodeIds: [e.id] },
      changes: [{ op: "updateNode", nodeId: c.id, set: { props: { status: "done", doneAt: m.doneAt } }, note, receipt: { quote: e.label, confidence: m.confidence } }],
    });
    return !!id;
  }
  return false;
}

/* ── Contradiction fixes ─────────────────────────────────────────────────────────────────────────────── */

/** Where a contradiction has a clear winner and the commitment holds the losing value: propose the fix. */
export async function proposeContradictionFixes(graphId: string, commitmentIds: string[] | null): Promise<number> {
  return serial(graphId, async () => {
    let n = 0;
    for (const owner of await ownersIn(graphId, false)) {
      const v = await asOwner(owner, graphId);
      if (!v) continue;
      const list = await ownOpen(v, commitmentIds ?? undefined);
      if (!list.length) continue;
      const locale = await localeOf(v.id) as WatchLocale;
      const own = await ownSourcesOf(v, list);
      const parties = await partiesFor(v, list, own, { wide: true });
      for (const c of list) {
        const o = own.get(c.id) ?? { ids: [], threadKeys: [], firstAt: null };
        const party = parties.get(c.id) ?? [];
        const st = await statementsFor(v, c, o, party);
        if (st.length < 1) continue;
        const rules = await rulesFor(v, c, st);
        const found = findContradictions({ id: c.id, kind: c.props.kind, dueAt: c.props.dueAt, amount: c.props.amount ?? null }, [...st, ...rules], TZ);
        for (const x of found) {
          if (!x.fix || x.fix.from.cls === "rule" || x.fix.from.sourceId.startsWith("rule:")) continue;
          const text = explainContradiction(x, locale);
          const key = `fix:${c.id}:${x.key}`;
          const title = locale === "da" ? `Ret „${c.label}“` : `Update “${c.label}”`;
          const id = await proposeOnce(v, key, {
            watch: "fix", title, description: text, evidence: { sourceId: x.fix.from.sourceId, quote: x.fix.from.quote },
            changes: [{ op: "updateNode", nodeId: c.id, set: x.fix.set, note: text, receipt: { sourceId: x.fix.from.sourceId, quote: x.fix.from.quote, confidence: 0.75 } }],
          });
          if (id) n++;
        }
      }
    }
    return n;
  });
}

/* ── Hooks ───────────────────────────────────────────────────────────────────────────────────────────── */

const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; ids: Set<string> | null }>();

/**
 * After a change set was delivered: when commitments or events were added or changed, look again (debounced a few
 * seconds per graph, so a burst of deliveries is one check). `nodeIds` null = look at everything.
 */
export async function afterDelivery(graphId: string, touched: { nodeIds: string[]; edgeIds: string[] }): Promise<void> {
  const nodeIds = touched.nodeIds.filter(Boolean);
  let relevant = false;
  let commitmentIds: string[] = [];
  if (nodeIds.length) {
    const rows = await db.select({ id: nodes.id, type: nodes.type }).from(nodes).where(and(eq(nodes.graphId, graphId), inArray(nodes.id, nodeIds)));
    commitmentIds = rows.filter((r) => r.type === "commitment").map((r) => r.id);
    relevant = rows.some((r) => r.type === "commitment" || r.type === "event");
  }
  if (!relevant && touched.edgeIds.length) {
    const rows = await db.select({ relation: edges.relation, fromId: edges.fromId }).from(edges).where(and(eq(edges.graphId, graphId), inArray(edges.id, touched.edgeIds)));
    relevant = rows.some((r) => ["responsible_for", "involves", "about", "with", "parent_of", "happened_at", "located_at"].includes(r.relation));
  }
  if (!relevant) return;
  const p = pending.get(graphId);
  const ids = p ? (p.ids && commitmentIds.length ? new Set([...p.ids, ...commitmentIds]) : p.ids ?? (commitmentIds.length ? new Set(commitmentIds) : null)) : (commitmentIds.length ? new Set(commitmentIds) : null);
  if (p) clearTimeout(p.timer);
  const timer = setTimeout(() => {
    pending.delete(graphId);
    const list = ids ? [...ids] : [];
    void (async () => {
      await checkClashes(graphId);
      if (list.length) {
        await checkCommitmentsAgainstRecent(graphId, list);
        await proposeContradictionFixes(graphId, list);
      }
    })().catch((e) => console.error("[commitments/watch] after delivery", e instanceof Error ? e.message : e));
  }, 3000);
  (timer as { unref?: () => void }).unref?.();
  pending.set(graphId, { timer, ids });
}

/** After a source was read (the pipeline marks it ready): is it proof that something is done? */
export async function afterSourceRead(sourceId: string): Promise<void> {
  await checkSourceForFulfilment(sourceId).catch((e) => console.error("[commitments/watch] after read", e instanceof Error ? e.message : e));
}

/** The daily run for one graph: clashes, appointments that happened, late proof, and contradiction fixes. */
export async function dailyWatch(graphId: string, now = new Date()): Promise<{ clashes: number; done: number; fixes: number }> {
  const clashes = await checkClashes(graphId, now);
  const done = await checkCommitmentsAgainstRecent(graphId, null, now);
  const fixes = await proposeContradictionFixes(graphId, null);
  return { clashes, done, fixes };
}
