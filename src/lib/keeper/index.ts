/**
 * The Brain Keeper (server-only), after mux's keeper (mux/server/src/keeper.ts): the part of My Graph that looks after
 * memory on its own. Every 15 minutes (or when someone presses "Run now" on the Memory page) it reads, for one person
 * in one graph, what happened since its last run — their conversations, the memories the chat handed it, new library
 * sources (as data, never instructions), the assistant's activity for them, change sets they delivered — and keeps
 * memory: writes down what will matter later, updates instead of adding near-copies, merges duplicates and retires what
 * is no longer true. It never rewrites or removes what a person wrote themselves, never makes a memory wider than its
 * evidence, and keeps anything resting only on outside content pending. It changes nothing but memory, and every
 * change is journalled on its run (keeper_runs) with why and links; the Memory page shows the report.
 *
 * Runs as the person (viewerFor), so it only ever sees what they may see in that graph. Model calls go through mux
 * (route "smart", agent "my-graph:brain-keeper"; sensitive material stays on local models). When mux is down it still
 * empties its inbox without judgement (see fallbackActions).
 */
import { voiceOf } from "@/lib/assistant/locale";
import { localizeTitle, readerT } from "@/lib/changes";
import type { TFn } from "@/lib/i18n/core";
import { and, desc, eq, gt, inArray, isNotNull, like, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { assistantActivity, changeSets, conversations, keeperRuns, messages, sources } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { viewerFor } from "@/lib/auth/viewer-for";
import { accessContext } from "@/lib/gbrain";
import { sourceReadSql } from "@/lib/gbrain/access";
import { addMemory, canAddMemory } from "@/lib/memory";
import { keeperDrop, keeperMemories, keeperUpdate } from "@/lib/memory/keeper";
import * as mux from "@/lib/mux";
import { resolveNode } from "@/lib/assistant/apply";
import { citationsAnyOutside, citationsOnlyOutside } from "@/lib/assistant/context";
import { inferBasis } from "@/lib/assistant/policy";
import { parseProposals } from "@/lib/assistant/proposals";
import { isSensitivity, memoryVisibilityFor } from "@/lib/assistant/sensitivity";
import { decisionKey, foldState } from "@/lib/assistant/state";
import { addState, conversationRows } from "@/lib/assistant/store";
import {
  composeReport, FIRST_LOOKBACK_MS, hasMaterial, KEEPER_EVERY_MS, parseKeeperOutput, reportHeadline, STALE_RUN_MS, vetActions, fallbackActions,
  type Evidence, type JournalEntry, type KeeperAction, type Planned,
} from "./pure";
import { keeperSystemPrompt, keeperUserPrompt } from "./prompt";

export class KeeperBusyError extends Error {
  constructor() { super("The Brain Keeper is already running for you in this graph."); }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/* ── Runs ───────────────────────────────────────────────────────────────────────────────────────────── */

export type KeeperRunView = {
  id: string; trigger: string; status: "running" | "done" | "failed" | "skipped"; startedAt: string; finishedAt: string | null;
  read: Record<string, number>; headline: string; report: string | null; model: string | null; error: string | null;
  actions: (Omit<JournalEntry, "links"> & { href: string | null; links: (JournalEntry["links"][number] & { href: string })[] })[];
};

const hrefOf = (l: JournalEntry["links"][number]) =>
  l.type === "conversation" ? `/chat/${l.id}` : l.type === "source" ? `/library/${l.id}` : `/changes/${l.id}`;

function toView(r: typeof keeperRuns.$inferSelect, t: TFn): KeeperRunView {
  const actions = (r.actions as unknown as JournalEntry[]) ?? [];
  return {
    id: r.id, trigger: r.trigger, status: (["running", "done", "failed", "skipped"].includes(r.status) ? r.status : "failed") as KeeperRunView["status"],
    startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null, read: r.read ?? {},
    headline: r.status === "running" ? t("memory.keeper.report.running") : r.status === "failed" ? t("memory.keeper.report.failed") : reportHeadline(actions, t),
    report: r.report, model: r.model, error: r.error,
    actions: actions.map((a) => ({
      ...a,
      href: a.memoryId && a.op !== "merged" && a.op !== "declined" ? `/memory#memory-${a.memoryId}` : a.memoryId && a.op === "merged" ? `/memory#memory-${a.memoryId}` : null,
      links: (a.links ?? []).map((l) => ({ ...l, href: hrefOf(l) })),
    })),
  };
}

/** The viewer's own keeper runs in this graph, newest first. Nobody sees another person's runs. */
export async function listKeeperRuns(v: Viewer, limit = 10): Promise<KeeperRunView[]> {
  if (!canAddMemory(v) && v.role !== "owner" && v.role !== "parent") return [];
  const rows = await db.select().from(keeperRuns)
    .where(and(eq(keeperRuns.graphId, v.graphId), eq(keeperRuns.userId, v.id)))
    .orderBy(desc(keeperRuns.startedAt)).limit(Math.max(1, Math.min(limit, 50)));
  const { t } = await voiceOf(v);
  return rows.map((r) => toView(r, t));
}

export type KeeperStatus = { busy: boolean; waiting: number; lastFinishedAt: string | null; nextRunAt: string | null; runs: KeeperRunView[] };

export async function keeperStatus(v: Viewer): Promise<KeeperStatus> {
  const runs = await listKeeperRuns(v, 8);
  const busy = runs.some((r) => r.status === "running" && Date.now() - Date.parse(r.startedAt) < STALE_RUN_MS);
  const last = runs.find((r) => r.status !== "running" && r.finishedAt);
  const waiting = (await inboxItems(v)).length;
  const base = last?.finishedAt ? Date.parse(last.finishedAt) : Date.now();
  return { busy, waiting, lastFinishedAt: last?.finishedAt ?? null, nextRunAt: new Date(Math.max(base + KEEPER_EVERY_MS, Date.now())).toISOString(), runs };
}

async function lastFinished(graphId: string, userId: string): Promise<Date | null> {
  const [r] = await db.select({ at: keeperRuns.finishedAt }).from(keeperRuns)
    .where(and(eq(keeperRuns.graphId, graphId), eq(keeperRuns.userId, userId), inArray(keeperRuns.status, ["done", "skipped"]), isNotNull(keeperRuns.finishedAt)))
    .orderBy(desc(keeperRuns.finishedAt)).limit(1);
  return r?.at ?? null;
}

/** Runs left "running" by a process that died. */
async function clearStale(graphId: string, userId: string) {
  await db.update(keeperRuns).set({ status: "failed", error: "The app restarted during the run.", finishedAt: new Date() })
    .where(and(eq(keeperRuns.graphId, graphId), eq(keeperRuns.userId, userId), eq(keeperRuns.status, "running"),
      sql`${keeperRuns.startedAt} < now() - make_interval(secs => ${Math.round(STALE_RUN_MS / 1000)})`));
}

/* ── What it reads ──────────────────────────────────────────────────────────────────────────────────── */

type InboxItem = Extract<Evidence, { type: "inbox" }>;

/** Memories the chat handed to the keeper and nobody has decided yet (this person's chats in this graph). */
async function inboxItems(v: Viewer): Promise<InboxItem[]> {
  const convIds = await db.selectDistinct({ id: messages.conversationId }).from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(and(eq(conversations.graphId, v.graphId), eq(conversations.userId, v.id), eq(messages.role, "system"),
      like(messages.content, `my-graph-state:%"queued"%`), gt(messages.createdAt, new Date(Date.now() - 30 * 86400_000))))
    .limit(30);
  const out: InboxItem[] = [];
  for (const { id } of convIds) {
    const [c] = await db.select({ sensitivity: conversations.sensitivity }).from(conversations).where(eq(conversations.id, id));
    const rows = await conversationRows(id);
    const { decisions } = foldState(rows.filter((r) => r.role === "system").map((r) => r.content));
    const level = isSensitivity(c?.sensitivity) ? c!.sensitivity as "normal" | "parents" | "private" : "normal";
    for (const msg of rows) {
      if (msg.role !== "assistant") continue;
      const parsed = parseProposals(msg.content).proposals;
      parsed.forEach((p, i) => {
        if (p.type !== "propose_memory") return;
        if (decisions.get(decisionKey(msg.id, i + 1))?.status !== "queued") return;
        const userText = rows.filter((r) => r.role === "user" && r.createdAt <= msg.createdAt).map((r) => r.content).join("\n");
        const basis = inferBasis(p, { userText, citedOnlyDocuments: citationsOnlyOutside(msg.citations ?? []), citedDocuments: citationsAnyOutside(msg.citations ?? []) });
        out.push({
          ref: "", type: "inbox", conversationId: id, messageId: msg.id, n: i + 1, kind: p.kind, text: p.text, about: p.about,
          quote: p.quote, basis, visibility: memoryVisibilityFor(level),
        });
      });
    }
  }
  return out.slice(0, 30);
}

async function material(v: Viewer, since: Date): Promise<{ evidence: Evidence[]; read: Record<string, number>; sensitive: boolean }> {
  const evidence: Evidence[] = [];
  let sensitive = false;

  const convs = await db.select({ id: conversations.id, title: conversations.title, sensitivity: conversations.sensitivity }).from(conversations)
    .where(and(eq(conversations.graphId, v.graphId), eq(conversations.userId, v.id), gt(conversations.updatedAt, since)))
    .orderBy(desc(conversations.updatedAt)).limit(8);
  let ci = 0;
  for (const c of convs) {
    const rows = (await conversationRows(c.id)).filter((r) => (r.role === "user" || r.role === "assistant") && r.createdAt > since);
    if (!rows.some((r) => r.role === "user")) continue;
    if (c.sensitivity !== "normal") sensitive = true;
    const level = isSensitivity(c.sensitivity) ? c.sensitivity : "normal";
    const transcript = clip(rows.map((r) => `${r.role === "user" ? "Person" : "Assistant"}: ${clip(r.role === "assistant" ? parseProposals(r.content).text : r.content, 700)}`).join("\n"), 5000);
    evidence.push({ ref: `c${++ci}`, type: "conversation", conversationId: c.id, title: c.title, visibility: memoryVisibilityFor(level), userText: rows.filter((r) => r.role === "user").map((r) => r.content).join("\n"), transcript });
  }

  const inbox = await inboxItems(v);
  inbox.forEach((it, i) => { it.ref = `m${i + 1}`; if (it.visibility !== "household") sensitive = true; evidence.push(it); });

  const ctx = await accessContext(v);
  const srcs = await db.select({ id: sources.id, kind: sources.kind, title: sources.title, text: sources.textContent, meta: sources.meta, visibility: sources.visibility, sensitive: sources.sensitive })
    .from(sources)
    .where(and(eq(sources.graphId, v.graphId), eq(sources.ownerId, v.id), eq(sources.status, "ready"), ne(sources.kind, "chat"), gt(sources.createdAt, since), sourceReadSql(ctx, "sources")))
    .orderBy(desc(sources.createdAt)).limit(6);
  srcs.forEach((s, i) => {
    if (s.sensitive) sensitive = true;
    const summary = typeof s.meta?.summary === "string" ? s.meta.summary : "";
    evidence.push({
      ref: `s${i + 1}`, type: "source", sourceId: s.id, sourceKind: s.kind, title: s.title,
      excerpt: clip((summary || s.text || "").replace(/\s+/g, " ").trim(), 900), visibility: s.sensitive ? "private" : s.visibility,
    });
  });

  const acts = await db.select({ summary: assistantActivity.summary }).from(assistantActivity)
    .where(and(eq(assistantActivity.graphId, v.graphId), eq(assistantActivity.userId, v.id), gt(assistantActivity.createdAt, since), ne(assistantActivity.actor, "keeper")))
    .orderBy(desc(assistantActivity.createdAt)).limit(15);
  acts.forEach((a, i) => evidence.push({ ref: `a${i + 1}`, type: "activity", text: clip(a.summary, 240) }));

  const sets = await db.select({ id: changeSets.id, title: changeSets.title, titleKey: changeSets.titleKey, titleParams: changeSets.titleParams }).from(changeSets)
    .where(and(eq(changeSets.graphId, v.graphId), eq(changeSets.status, "delivered"), gt(changeSets.deliveredAt, since),
      or(eq(changeSets.createdBy, v.id), eq(changeSets.deliveredBy, v.id))))
    .orderBy(desc(changeSets.deliveredAt)).limit(8);
  const tr = await readerT(v);
  sets.forEach((s, i) => evidence.push({ ref: `d${i + 1}`, type: "changeset", changeSetId: s.id, title: clip(localizeTitle(s, tr), 200) }));

  const read = { conversations: ci, proposals: inbox.length, sources: srcs.length, activity: acts.length, changeSets: sets.length };
  return { evidence, read, sensitive };
}

/* ── One run ────────────────────────────────────────────────────────────────────────────────────────── */

/** Is there anything for the keeper to read for this person since its last run? (cheap; used by the scheduler) */
async function due(v: Viewer, since: Date): Promise<boolean> {
  const [c] = await db.select({ id: conversations.id }).from(conversations)
    .where(and(eq(conversations.graphId, v.graphId), eq(conversations.userId, v.id), gt(conversations.updatedAt, since))).limit(1);
  if (c) return true;
  const [s] = await db.select({ id: sources.id }).from(sources)
    .where(and(eq(sources.graphId, v.graphId), eq(sources.ownerId, v.id), eq(sources.status, "ready"), ne(sources.kind, "chat"), gt(sources.createdAt, since))).limit(1);
  return !!s;
}

/**
 * Run the keeper for this person in their current graph. `trigger` "person" = Run now (always records a run);
 * "schedule" = only when there is new material. Throws KeeperBusyError if a run is already going.
 */
export async function runKeeper(v: Viewer, trigger: "schedule" | "person" = "person"): Promise<KeeperRunView | null> {
  if (!canAddMemory(v)) return null;
  await clearStale(v.graphId, v.id);
  const since = (await lastFinished(v.graphId, v.id)) ?? new Date(Date.now() - FIRST_LOOKBACK_MS);
  if (trigger === "schedule" && !(await due(v, since)) && !(await inboxItems(v)).length) return null;

  let runId: string;
  try {
    const [row] = await db.insert(keeperRuns).values({ graphId: v.graphId, userId: v.id, trigger, status: "running", since }).returning({ id: keeperRuns.id });
    runId = row.id;
  } catch {
    throw new KeeperBusyError();
  }

  try {
    const m = await material(v, since);
    const { t } = await voiceOf(v);
    if (!hasMaterial(m.read)) {
      await db.update(keeperRuns).set({ status: trigger === "person" ? "done" : "skipped", read: m.read, finishedAt: new Date(), report: t("memory.keeper.report.nothing") }).where(eq(keeperRuns.id, runId));
      return (await listKeeperRuns(v, 1))[0] ?? null;
    }
    const mems = await keeperMemories(v);

    let actions: KeeperAction[];
    let degraded = false;
    let model: string | null = null;
    try {
      const out = await mux.complete({
        route: "smart", maxTokens: 2500, temperature: 0, json: true,
        messages: [
          { role: "system", content: keeperSystemPrompt({ graphName: v.graphName, graphKind: v.graphKind, personName: v.name, memories: mems, locale: (await voiceOf(v)).locale }) },
          { role: "user", content: keeperUserPrompt(m.evidence) },
        ],
        meta: { userId: v.id, agent: "my-graph:brain-keeper", traceId: runId, sensitive: m.sensitive, graphId: v.graphId },
      });
      model = out.model;
      let raw: unknown = {};
      try { raw = JSON.parse(out.text.slice(out.text.indexOf("{"), out.text.lastIndexOf("}") + 1)); } catch { raw = {}; }
      const parsed = parseKeeperOutput(raw);
      actions = parsed.actions;
    } catch (e) {
      if (!(e instanceof mux.MuxError) && !(e instanceof mux.MuxUnavailableError) && !(e instanceof mux.MuxAuthError)) console.error("[keeper] model call failed:", e);
      actions = fallbackActions(m.evidence);
      degraded = true;
    }

    const { planned, refused } = vetActions(actions, { memories: mems, evidence: m.evidence });
    const journal = await apply(v, runId, planned, m.evidence);
    const report = composeReport(m.read, refused, { degraded, t });
    if (refused.length) console.info(`[keeper] run ${runId}: refused ${refused.length}:`, refused.map((r) => `${r.action} (${r.reason})`).join("; "));

    await db.update(keeperRuns).set({
      status: "done", read: m.read, actions: journal as unknown as Record<string, unknown>[], report: clip(report, 2000) || null, model, finishedAt: new Date(),
    }).where(eq(keeperRuns.id, runId));
  } catch (e) {
    console.error("[keeper] run failed:", e);
    await db.update(keeperRuns).set({ status: "failed", error: e instanceof Error ? clip(e.message, 500) : "Unknown error", finishedAt: new Date() }).where(eq(keeperRuns.id, runId));
  }
  return (await listKeeperRuns(v, 1))[0] ?? null;
}

async function logKeeper(v: Viewer, runId: string, summary: string, memoryId: string | null, visibility: "private" | "parents" | "household") {
  await db.insert(assistantActivity).values({
    graphId: v.graphId, userId: v.id, actor: "keeper", action: "kept_memory", summary: clip(summary, 300),
    subjectType: memoryId ? "memory" : null, subjectId: memoryId, visibility,
  }).catch((e) => console.error("[keeper] activity log failed:", e, runId));
}

/** Apply the vetted plan as the person; returns the journal. Each write is independent: one failure doesn't stop the rest. */
async function apply(v: Viewer, runId: string, planned: Planned[], evidence: Evidence[]): Promise<JournalEntry[]> {
  const inbox = new Map(evidence.filter((e): e is InboxItem => e.type === "inbox").map((e) => [e.ref, e]));
  const journal: JournalEntry[] = [];
  const settle = async (ref: string, s: { status: "approved" | "dismissed"; label?: string; memoryId?: string | null; undoable?: boolean; why: string }) => {
    const it = inbox.get(ref);
    if (!it) return;
    inbox.delete(ref);
    await addState(it.conversationId, {
      type: "proposal", messageId: it.messageId, n: it.n, status: s.status, auto: "keeper", why: clip(s.why, 400),
      result: s.status === "approved" ? { label: s.label ?? "Kept by the Brain Keeper", href: s.memoryId ? `/memory#memory-${s.memoryId}` : "/memory", undo: s.undoable && s.memoryId ? { type: "memory", id: s.memoryId } : null } : null,
    }).catch((e) => console.error("[keeper] inbox state failed:", e));
  };

  for (const p of planned) {
    try {
      if (p.op === "write") {
        const about = (await Promise.all(p.about.map((name) => resolveNode(v, name).catch(() => null)))).filter((n) => !!n).map((n) => n!.id);
        const mem = await addMemory(v, {
          kind: p.kind, text: p.text, aboutNodeIds: about, origin: p.origin, createdByKind: "assistant",
          conversationId: p.conversationId ?? undefined, messageId: p.messageId ?? undefined, sourceId: p.sourceId ?? undefined,
          quote: p.quote ?? undefined, confidence: p.status === "active" ? 0.85 : 0.6, visibility: p.visibility, actor: "keeper",
        });
        if (!mem) continue;
        journal.push({ op: "wrote", memoryId: mem.id, text: mem.text, why: p.why, status: mem.status === "pending" ? "pending" : "active", visibility: mem.visibility, ownerId: v.id, links: p.links });
        for (const ref of p.inboxRefs) await settle(ref, { status: "approved", label: mem.status === "pending" ? `Kept, waiting for you to confirm: ${mem.text}` : `Remembered: ${mem.text}`, memoryId: mem.id, undoable: true, why: p.why });
      } else if (p.op === "update") {
        const ok = (p.text || p.kind || p.visibility) ? await keeperUpdate(v, p.id, { text: p.text, kind: p.kind, visibility: p.visibility }) : true;
        if (!ok) continue;
        if (p.text || p.kind || p.visibility) {
          journal.push({ op: "updated", memoryId: p.id, text: p.text ?? p.before, before: [p.before], why: p.why, visibility: p.visibility ?? undefined, ownerId: v.id, links: p.links });
          await logKeeper(v, runId, `Brain Keeper updated a memory: "${p.text ?? p.before}"`, p.id, p.visibility ?? "private");
        }
        for (const ref of p.inboxRefs) await settle(ref, { status: "approved", label: `Already remembered: ${p.text ?? p.before}`, memoryId: p.id, undoable: false, why: p.why });
      } else if (p.op === "merge") {
        if (p.text || p.visibility) {
          const ok = await keeperUpdate(v, p.keepId, { text: p.text, visibility: p.visibility });
          if (!ok && p.text) continue;
        }
        const dropped = await keeperDrop(v, p.dropIds);
        if (!dropped.length) continue;
        journal.push({ op: "merged", memoryId: p.keepId, text: p.text ?? p.before[0], before: p.before, why: p.why, ownerId: v.id, links: [] });
        await logKeeper(v, runId, `Brain Keeper merged ${dropped.length + 1} memories that said the same thing`, p.keepId, "private");
      } else if (p.op === "forget") {
        if (!(await keeperUpdate(v, p.id, { status: "paused" }))) continue;
        journal.push({ op: "forgot", memoryId: p.id, text: p.before, why: p.why, ownerId: v.id, links: p.links });
        await logKeeper(v, runId, `Brain Keeper retired a memory that is no longer true: "${p.before}"`, p.id, "private");
      } else if (p.op === "decline") {
        const it = inbox.get(p.ref);
        if (!it) continue;
        journal.push({ op: "declined", memoryId: null, text: it.text, why: p.why, ownerId: v.id, links: [{ type: "conversation", id: it.conversationId, title: "the chat it came up in" }] });
        await settle(p.ref, { status: "dismissed", why: p.why });
      }
    } catch (e) {
      console.error(`[keeper] ${p.op} failed:`, e);
    }
  }
  return journal;
}

/* ── The schedule ───────────────────────────────────────────────────────────────────────────────────── */

/**
 * Every 15 minutes: find people with new material since their last run (in any graph they belong to) and run the
 * keeper for each, one after the other. Never throws.
 */
export async function keeperTick(limit = 10): Promise<number> {
  let n = 0;
  try {
    const lookback = Math.round(FIRST_LOOKBACK_MS / 1000);
    const rows = await db.execute<{ graph_id: string; user_id: string }>(sql`
      with last as (
        select graph_id, user_id, max(finished_at) as at from keeper_runs where status in ('done', 'skipped') group by graph_id, user_id
      ),
      fresh as (
        select c.graph_id, c.user_id, c.updated_at as at from conversations c
        union all
        select s.graph_id, s.owner_id, s.created_at from sources s where s.status = 'ready' and s.kind <> 'chat'
      )
      select distinct f.graph_id, f.user_id from fresh f
      left join last l on l.graph_id = f.graph_id and l.user_id = f.user_id
      where f.at > coalesce(l.at, now() - make_interval(secs => ${lookback}))
      limit ${limit}`);
    for (const r of rows as unknown as { graph_id: string; user_id: string }[]) {
      const v = await viewerFor(String(r.user_id), String(r.graph_id)).catch(() => null);
      if (!v || !canAddMemory(v)) continue;
      try {
        if (await runKeeper(v, "schedule")) n++;
      } catch (e) {
        if (!(e instanceof KeeperBusyError)) console.error("[keeper] scheduled run failed:", e);
      }
    }
  } catch (e) {
    console.error("[keeper] tick failed:", e instanceof Error ? e.message : e);
  }
  return n;
}
