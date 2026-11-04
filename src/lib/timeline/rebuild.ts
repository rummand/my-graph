/**
 * "Rebuild the timeline from the library" (server-only): re-read every source in the current graph that the viewer
 * may open, in the background, for what is still missing (its own date, its conversation, what it would add), and
 * join mail threads split across uploads. Idempotent: what is already known is skipped (see ingest/classify.ts
 * rebuildNeeds), so running it twice proposes nothing new the second time. Findings arrive as change sets to review;
 * nothing goes into the graph without a person. Progress lives in memory per graph (in-process background work).
 */
import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { sources } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { accessContext } from "@/lib/gbrain";
import { scopeOf } from "@/lib/graphs/pure";
import { sourceVisibleTo } from "@/lib/ingest/access";
import { resolveThreads } from "@/lib/ingest/mail";
import { refreshSource } from "@/lib/ingest/pipeline";
import * as mux from "@/lib/mux";

export type RebuildProgress = {
  status: "running" | "done" | "failed";
  startedBy: string;
  startedAt: string;
  finishedAt: string | null;
  total: number;
  done: number;
  dates: number;
  threads: number;
  joined: number;
  proposals: number;
  proposedChanges: number;
  skipped: number;
  errors: number;
  muxUp: boolean;
  changeSetIds: string[];
  error: string | null;
};

const g = globalThis as unknown as { __timelineRebuilds?: Map<string, RebuildProgress> };
const jobs = (g.__timelineRebuilds ??= new Map());

export function rebuildProgress(v: Viewer): RebuildProgress | null {
  return jobs.get(v.graphId) ?? null;
}

/** Start a rebuild for the viewer's graph, or return the one already running. */
export async function startRebuild(v: Viewer): Promise<{ progress: RebuildProgress; started: boolean } | { error: string; status: number }> {
  if (!scopeOf(v).canWrite) return { error: "You can look at this graph but not rebuild it.", status: 403 };
  if (!(await accessContext(v)).active) return { error: "Your access to this graph has ended.", status: 403 };
  const cur = jobs.get(v.graphId);
  if (cur?.status === "running") return { progress: cur, started: false };
  let muxUp = false;
  try { muxUp = (await mux.muxHealth()).ok; } catch { muxUp = false; }
  const p: RebuildProgress = {
    status: "running", startedBy: v.name, startedAt: new Date().toISOString(), finishedAt: null,
    total: 0, done: 0, dates: 0, threads: 0, joined: 0, proposals: 0, proposedChanges: 0, skipped: 0, errors: 0,
    muxUp, changeSetIds: [], error: null,
  };
  jobs.set(v.graphId, p);
  void run(v, p).catch((e) => {
    console.error("[timeline rebuild]", e);
    p.status = "failed";
    p.error = e instanceof Error ? e.message.slice(0, 300) : "The rebuild stopped.";
    p.finishedAt = new Date().toISOString();
  });
  return { progress: p, started: true };
}

async function run(v: Viewer, p: RebuildProgress) {
  const rows = await db.select({ id: sources.id }).from(sources)
    .where(and(eq(sources.graphId, v.graphId), sourceVisibleTo(v), sql`${sources.kind} in ('upload', 'email', 'manual', 'sync', 'web', 'connector')`))
    .orderBy(asc(sources.createdAt)).limit(10_000);
  p.total = rows.length;
  for (const r of rows) {
    const out = await refreshSource(v, r.id, p.muxUp);
    p.done++;
    if (out.skipped) p.skipped++;
    if (out.date) p.dates++;
    if (out.thread) p.threads++;
    if (out.error) p.errors++;
    if (out.changeSetId) { p.proposals++; p.changeSetIds = [out.changeSetId, ...p.changeSetIds].slice(0, 20); }
    p.proposedChanges += out.proposed;
  }
  p.joined = await joinThreads(v);
  p.status = "done";
  p.finishedAt = new Date().toISOString();
}

/** Give every message of a conversation the same thread key, even when its messages came in separate uploads. */
async function joinThreads(v: Viewer): Promise<number> {
  const mail = await db.select({ id: sources.id, threadKey: sources.threadKey, meta: sources.meta }).from(sources)
    .where(and(eq(sources.graphId, v.graphId), sourceVisibleTo(v), sql`(${sources.mime} = 'message/rfc822' or ${sources.kind} = 'email')`)).limit(20_000);
  const msgs = mail.map((m) => {
    const e = ((m.meta ?? {}).email ?? {}) as { messageId?: string | null; inReplyTo?: string | null; references?: string[] };
    return { id: m.id, threadKey: m.threadKey, messageId: e.messageId ?? undefined, inReplyTo: e.inReplyTo ?? undefined, references: Array.isArray(e.references) ? e.references : [] };
  });
  const keys = resolveThreads(msgs);
  let changed = 0;
  for (const m of msgs) {
    if (!m.messageId) continue;
    const k = keys.get(m.messageId.toLowerCase());
    if (k && k !== m.threadKey) {
      await db.update(sources).set({ threadKey: k }).where(eq(sources.id, m.id));
      changed++;
    }
  }
  return changed;
}
