/**
 * The ledger (server-only): every commitment the viewer may see in the current graph, counted and grouped, with the
 * proposals of new ones waiting for a person, and the short forms Today, search and the assistant use.
 */
import type { Viewer } from "@/lib/auth";
import { listChangeSets, type ChangeSetView } from "@/lib/changes";
import { scopeOf } from "@/lib/graphs/pure";
import {
  assistantLine, countLedger, daysUntil, DEFAULT_TZ, groupByUrgency, urgencyOf,
  type CommitmentView, type LedgerCounts, type Party,
} from "./pure";
import { syncReminders } from "./reminders";
import { loadCommitments, readablePeople } from "./store";
import { contradictionFlags, withProgress, type CommitmentFlag } from "./watch/flags";

/** WATCH's progress signals folded into the props (a reply in the same thread is progress); the list as-is if that fails. */
async function progressed(v: Viewer, list: CommitmentView[]): Promise<CommitmentView[]> {
  try { return await withProgress(v, list); } catch (e) { console.error("[commitments] progress signals failed", e); return list; }
}

export type LedgerData = {
  /** Open ones, done ones and the recently dropped (the client filters and groups with ./pure). */
  items: CommitmentView[];
  counts: LedgerCounts;
  /** Everyone responsible for something open (the person filter's avatars). */
  people: Party[];
  /** People in the graph the viewer may read (Reassign). */
  everyone: Party[];
  /** The viewer's own person node (for "mine"). */
  me: string | null;
  /** Two sources that disagree about a commitment's date, amount or period (WATCH), by commitment id. */
  flags: Record<string, CommitmentFlag[]>;
  canWrite: boolean;
  now: string;
  tz: string;
};

/** The whole ledger. Also brings each commitment's reminder in line (create, adopt detection's, move, close). */
export async function loadLedger(v: Viewer, opts: { now?: Date; tz?: string; personId?: string | null } = {}): Promise<LedgerData> {
  const now = opts.now ?? new Date();
  const tz = opts.tz ?? DEFAULT_TZ;
  const canWrite = scopeOf(v).canWrite && v.role !== "guest";
  const [all, everyone] = await Promise.all([
    loadCommitments(v, { status: "all", personId: opts.personId ?? null }),
    canWrite ? readablePeople(v) : Promise.resolve([] as Party[]),
  ]);
  const recentMs = 30 * 86_400_000;
  const items = all.filter((c) => c.props.status !== "cancelled" || now.getTime() - Date.parse(c.props.cancelledAt ?? c.updatedAt) < recentMs);
  if (canWrite && (await syncReminders(v, items, now, tz)) > 0) {
    // Reminder ids changed: read them again so the rows link to the right reminder.
    const fresh = await loadCommitments(v, { ids: items.map((c) => c.id), status: "all" });
    const byId = new Map(fresh.map((c) => [c.id, c]));
    for (let i = 0; i < items.length; i++) items[i] = byId.get(items[i].id) ?? items[i];
  }
  const [withSignals, flags] = await Promise.all([
    progressed(v, items),
    contradictionFlags(v, items).catch((e) => { console.error("[commitments] contradiction flags failed", e); return {} as Record<string, CommitmentFlag[]>; }),
  ]);
  for (let i = 0; i < items.length; i++) items[i] = withSignals[i] ?? items[i];
  const people = new Map<string, Party>();
  for (const c of items) if (c.props.status === "open") for (const p of c.responsible) if (p.type === "person") people.set(p.id, { id: p.id, label: p.label, type: p.type });
  return {
    items, counts: countLedger(items, now, tz), people: [...people.values()].sort((a, b) => a.label.localeCompare(b.label)),
    everyone, me: v.personNodeId ?? null, flags, canWrite, now: now.toISOString(), tz,
  };
}

/** Proposals waiting in this graph that add a commitment ("Waiting for you" on the ledger). */
export async function waitingProposals(v: Viewer, limit = 6): Promise<ChangeSetView[]> {
  if (v.role === "guest") return [];
  const sets = await listChangeSets(v, { status: "draft", limit: 60 });
  return sets.filter((s) => s.changes.some((c) => c.op === "addNode" && c.included && (c.payload as { type?: unknown }).type === "commitment")).slice(0, limit);
}

export type TodayCommitments = {
  counts: LedgerCounts;
  /** Overdue first, then at risk: what to look at now (at most `max`). */
  urgent: CommitmentView[];
};

/** The one line on Today and the cards under it. */
export async function todayCommitments(v: Viewer, opts: { now?: Date; tz?: string; max?: number } = {}): Promise<TodayCommitments> {
  const now = opts.now ?? new Date();
  const tz = opts.tz ?? DEFAULT_TZ;
  const open = await progressed(v, await loadCommitments(v, { status: ["open"] }));
  if (scopeOf(v).canWrite && v.role !== "guest") void syncReminders(v, open, now, tz);
  const g = groupByUrgency(open, now, tz);
  return { counts: countLedger(open, now, tz), urgent: [...g.overdue, ...g.at_risk].slice(0, opts.max ?? 3) };
}

/** People's commitments, open, for the block on their page. */
export async function personCommitments(v: Viewer, personId: string, now = new Date(), tz = DEFAULT_TZ): Promise<CommitmentView[]> {
  const list = await progressed(v, await loadCommitments(v, { status: ["open"], personId }));
  const g = groupByUrgency(list.filter((c) => c.responsible.some((p) => p.id === personId)), now, tz);
  return [...g.overdue, ...g.at_risk, ...g.this_week, ...g.later, ...g.undated];
}

/**
 * For the assistant: open commitments that are overdue or due within `days`, as compact lines (with ids for the
 * citation). Sensitive ones the viewer doesn't own are named without their details.
 */
export async function commitmentContext(v: Viewer, opts: { now?: Date; tz?: string; days?: number; max?: number } = {}): Promise<{ id: string; line: string; sensitive: boolean; visibility: CommitmentView["visibility"]; ownerId: string; dueAt: string | null }[]> {
  const now = opts.now ?? new Date();
  const tz = opts.tz ?? DEFAULT_TZ;
  const days = opts.days ?? 14;
  const open = await loadCommitments(v, { status: ["open"] });
  return open
    .filter((c) => c.props.dueAt && daysUntil(c.props.dueAt, now, tz) <= days)
    .sort((a, b) => Date.parse(a.props.dueAt!) - Date.parse(b.props.dueAt!))
    .slice(0, opts.max ?? 12)
    .map((c) => {
      const hidden = c.sensitive && c.ownerId !== v.id;
      const u = urgencyOf(c.props, now, tz);
      return {
        id: c.id, sensitive: c.sensitive, visibility: c.visibility, ownerId: c.ownerId, dueAt: c.props.dueAt,
        line: hidden ? `${c.label} · due ${c.props.dueAt!.slice(0, 10)}${u === "overdue" ? " · OVERDUE" : ""}` : assistantLine(c, now, tz),
      };
    });
}
