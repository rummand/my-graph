/**
 * The ledger's pure logic (no DB, no server imports; the browser may import it): reading a commitment node's props
 * defensively, urgency, grouping, the next occurrence of a recurring one, the reminder that goes with it, and the
 * helpers that drop what the viewer may not see. Unit-tested in commitments.test.ts.
 */
import { randomUUIDish } from "./ids";
import {
  COMMITMENT_RELATIONS, DEFAULT_LEAD_DAYS,
  type CommitmentDirection, type CommitmentKind, type CommitmentProps, type CommitmentStatus, type CommitmentUrgency, type DueKind,
} from "./types";

export const DIRECTIONS: CommitmentDirection[] = ["owe", "owed", "promise"];
export const STATUSES: CommitmentStatus[] = ["open", "done", "cancelled", "missed"];
export const KINDS: CommitmentKind[] = ["reply", "payment", "renewal", "notice", "appointment", "form", "deliver", "return", "other"];
export const DUE_KINDS: DueKind[] = ["deadline", "date", "approx", "recurring"];
export const URGENCIES: CommitmentUrgency[] = ["overdue", "at_risk", "this_week", "later", "undated"];
/** Where the household lives unless told otherwise (dates are stored in UTC, days are counted here). */
export const DEFAULT_TZ = "Europe/Copenhagen";

/** Someone or something at the other end of a commitment's edge (only ones the viewer may read). */
export type Party = { id: string; label: string; type: string; edgeId?: string };
/** Where a commitment comes from: a library passage the viewer may open. */
export type CommitmentSource = { sourceId: string; title: string; quote: string | null; chunkId: string | null; page: number | null; href: string };

/** One commitment as the ledger, the UI, Today, search and the assistant see it (dates as ISO strings). */
export type CommitmentView = {
  id: string;
  label: string;
  summary: string | null;
  props: CommitmentProps;
  ownerId: string;
  visibility: "private" | "parents" | "household";
  sensitive: boolean;
  /** Who has to do it (or, for "owed", who it is owed to). */
  responsible: Party[];
  /** The other party. */
  counterparty: Party[];
  about: Party[];
  arisesFrom: Party[];
  clashes: Party[];
  sources: CommitmentSource[];
  reminder: { id: string; dueAt: string; done: boolean } | null;
  /** The viewer may change it directly (owner or edit share); otherwise their actions become proposals. */
  canEdit: boolean;
  createdAt: string;
  updatedAt: string;
};

/* ── Reading props ───────────────────────────────────────────────────────────────────────────────────── */

const isoOrNull = (x: unknown): string | null => {
  if (typeof x !== "string" && !(x instanceof Date)) return null;
  const d = new Date(x);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const oneOf = <T extends string>(list: readonly T[], x: unknown, fallback: T): T => (list.includes(x as T) ? (x as T) : fallback);
const strOrNull = (x: unknown, max = 500): string | null => (typeof x === "string" && x.trim() ? x.trim().slice(0, max) : null);

/**
 * The props of a commitment node, whatever is stored: unknown values fall back to safe defaults, the due date falls
 * back to the node's startAt and the kind to the node's meta kind.
 */
export function readProps(raw: Record<string, unknown> | null | undefined, node: { startAt?: Date | string | null; kind?: string | null } = {}): CommitmentProps {
  const p = raw ?? {};
  const amountRaw = p.amount as { value?: unknown; currency?: unknown } | null | undefined;
  const amount = amountRaw && typeof amountRaw === "object" && typeof amountRaw.value === "number" && Number.isFinite(amountRaw.value)
    ? { value: amountRaw.value, currency: typeof amountRaw.currency === "string" && amountRaw.currency.trim() ? amountRaw.currency.trim().toUpperCase().slice(0, 8) : "DKK" }
    : null;
  const lead = typeof p.leadDays === "number" && Number.isFinite(p.leadDays) && p.leadDays >= 0 ? Math.min(Math.round(p.leadDays), 365) : null;
  return {
    direction: oneOf(DIRECTIONS, p.direction, "owe"),
    status: oneOf(STATUSES, p.status, "open"),
    kind: oneOf(KINDS, p.kind, oneOf(KINDS, node.kind, "other")),
    dueAt: isoOrNull(p.dueAt) ?? isoOrNull(node.startAt ?? null),
    dueKind: oneOf(DUE_KINDS, p.dueKind, "deadline"),
    recurrence: strOrNull(p.recurrence, 200),
    leadDays: lead,
    amount,
    consequence: strOrNull(p.consequence, 500),
    doneAt: isoOrNull(p.doneAt),
    doneBy: strOrNull(p.doneBy, 60),
    doneEvidenceSourceId: strOrNull(p.doneEvidenceSourceId, 60),
    fingerprint: strOrNull(p.fingerprint, 300),
    snoozedUntil: isoOrNull(p.snoozedUntil),
    progressAt: isoOrNull(p.progressAt),
    progressNote: strOrNull(p.progressNote, 500),
    doneNote: strOrNull(p.doneNote, 500),
    cancelledAt: isoOrNull(p.cancelledAt),
    cancelReason: strOrNull(p.cancelReason, 200),
    previousId: strOrNull(p.previousId, 60),
  };
}

export function leadDaysOf(p: Pick<CommitmentProps, "leadDays" | "kind">): number {
  return typeof p.leadDays === "number" ? p.leadDays : DEFAULT_LEAD_DAYS[p.kind] ?? 2;
}

/* ── Days ────────────────────────────────────────────────────────────────────────────────────────────── */

const dayFmt = new Map<string, Intl.DateTimeFormat>();
/** "2026-11-14": the calendar day of `d` where the household lives. */
export function dayKey(d: Date | string, tz = DEFAULT_TZ): string {
  let f = dayFmt.get(tz);
  if (!f) {
    try { f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }); } catch { f = new Intl.DateTimeFormat("en-CA", { timeZone: DEFAULT_TZ, year: "numeric", month: "2-digit", day: "2-digit" }); }
    dayFmt.set(tz, f);
  }
  return f.format(typeof d === "string" ? new Date(d) : d);
}

/** Whole calendar days from `now` to `due` (0 = today, 1 = tomorrow, -1 = yesterday), in the household's zone. */
export function daysUntil(due: Date | string, now: Date, tz = DEFAULT_TZ): number {
  const a = Date.parse(`${dayKey(now, tz)}T00:00:00Z`);
  const b = Date.parse(`${dayKey(due, tz)}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/* ── Urgency ─────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Where an open commitment sits in the ledger (null when it is done, cancelled or missed):
 *  - overdue:   its day has passed;
 *  - at_risk:   due within its lead time and nobody has done anything about it yet (no progress, not snoozed).
 *               Appointments are never at risk on their own: there is nothing to do before them but turn up;
 *  - this_week: due in the next seven days;
 *  - later:     dated, further out;
 *  - undated:   no date known yet.
 */
export function urgencyOf(p: CommitmentProps, now: Date, tz = DEFAULT_TZ): CommitmentUrgency | null {
  if (p.status !== "open") return null;
  if (!p.dueAt) return "undated";
  const days = daysUntil(p.dueAt, now, tz);
  if (days < 0) return "overdue";
  const snoozed = !!p.snoozedUntil && Date.parse(p.snoozedUntil) > now.getTime();
  const progressed = !!p.progressAt;
  if (!snoozed && !progressed && p.kind !== "appointment" && days <= leadDaysOf(p)) return "at_risk";
  if (days <= 6) return "this_week";
  return "later";
}

const dueMs = (c: CommitmentView) => (c.props.dueAt ? Date.parse(c.props.dueAt) : Number.POSITIVE_INFINITY);
const byDue = (a: CommitmentView, b: CommitmentView) => dueMs(a) - dueMs(b) || a.label.localeCompare(b.label);

/** Open commitments by urgency, each list soonest first (undated: newest first). */
export function groupByUrgency(list: CommitmentView[], now: Date, tz = DEFAULT_TZ): Record<CommitmentUrgency, CommitmentView[]> {
  const out: Record<CommitmentUrgency, CommitmentView[]> = { overdue: [], at_risk: [], this_week: [], later: [], undated: [] };
  for (const c of list) {
    const u = urgencyOf(c.props, now, tz);
    if (u) out[u].push(c);
  }
  for (const u of URGENCIES) out[u].sort(u === "undated" ? (a, b) => b.createdAt.localeCompare(a.createdAt) : byDue);
  return out;
}

/** By the person responsible ("nobody yet" last, as person null), most first. One commitment may sit under several. */
export function groupByPerson(list: CommitmentView[]): { person: Party | null; items: CommitmentView[] }[] {
  const groups = new Map<string, { person: Party | null; items: CommitmentView[] }>();
  for (const c of list) {
    const people = c.responsible.filter((p) => p.type === "person");
    if (!people.length) {
      const g = groups.get("") ?? groups.set("", { person: null, items: [] }).get("")!;
      g.items.push(c);
    }
    for (const p of people) {
      const g = groups.get(p.id) ?? groups.set(p.id, { person: { id: p.id, label: p.label, type: p.type }, items: [] }).get(p.id)!;
      g.items.push(c);
    }
  }
  return [...groups.values()].sort((a, b) => (a.person ? 0 : 1) - (b.person ? 0 : 1) || b.items.length - a.items.length || (a.person?.label ?? "").localeCompare(b.person?.label ?? ""));
}

export function groupByDirection(list: CommitmentView[]): Record<CommitmentDirection, CommitmentView[]> {
  const out: Record<CommitmentDirection, CommitmentView[]> = { owe: [], owed: [], promise: [] };
  for (const c of list) out[c.props.direction].push(c);
  return out;
}

export function groupByKind(list: CommitmentView[]): Partial<Record<CommitmentKind, CommitmentView[]>> {
  const out: Partial<Record<CommitmentKind, CommitmentView[]>> = {};
  for (const c of list) (out[c.props.kind] ??= []).push(c);
  return out;
}

/** The ledger's tabs: what we owe, what is owed to us, promises (all open), and what was done. */
export type LedgerTab = "all" | "owe" | "owed" | "promise" | "done";
export const TABS: LedgerTab[] = ["all", "owe", "owed", "promise", "done"];

export function filterTab(list: CommitmentView[], tab: LedgerTab): CommitmentView[] {
  if (tab === "done") {
    return list.filter((c) => c.props.status === "done")
      .sort((a, b) => (b.props.doneAt ?? b.updatedAt).localeCompare(a.props.doneAt ?? a.updatedAt));
  }
  const open = list.filter((c) => c.props.status === "open");
  return tab === "all" ? open : open.filter((c) => c.props.direction === tab);
}

export function filterPerson(list: CommitmentView[], personId: string | null | undefined): CommitmentView[] {
  if (!personId) return list;
  return list.filter((c) => c.responsible.some((p) => p.id === personId) || c.counterparty.some((p) => p.id === personId) || c.about.some((p) => p.id === personId));
}

export type LedgerCounts = { open: number; overdue: number; atRisk: number; thisWeek: number; later: number; undated: number; done: number };

/**
 * Counts for the header line and Today. `thisWeek` counts every open one due in the next seven days (including those
 * at risk); `atRisk` and `overdue` are their own sections.
 */
export function countLedger(list: CommitmentView[], now: Date, tz = DEFAULT_TZ): LedgerCounts {
  const g = groupByUrgency(list, now, tz);
  const open = list.filter((c) => c.props.status === "open");
  const thisWeek = open.filter((c) => c.props.dueAt && daysUntil(c.props.dueAt, now, tz) >= 0 && daysUntil(c.props.dueAt, now, tz) <= 6).length;
  return {
    open: open.length, overdue: g.overdue.length, atRisk: g.at_risk.length, thisWeek, later: g.later.length, undated: g.undated.length,
    done: list.filter((c) => c.props.status === "done").length,
  };
}

/* ── Recurring ───────────────────────────────────────────────────────────────────────────────────────── */

type Rule = { freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY"; interval: number; until: number | null };

export function parseRRule(rrule: string | null | undefined): Rule | null {
  if (!rrule) return null;
  const parts = new Map(rrule.replace(/^RRULE:/i, "").split(";").map((kv) => kv.split("=") as [string, string]).map(([k, v]) => [k?.trim().toUpperCase(), (v ?? "").trim().toUpperCase()]));
  const freq = parts.get("FREQ");
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") return null;
  const interval = Math.max(1, Math.min(Number.parseInt(parts.get("INTERVAL") ?? "1", 10) || 1, 1000));
  const u = parts.get("UNTIL");
  let until: number | null = null;
  if (u) {
    const m = u.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/);
    until = m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 23), +(m[5] ?? 59), +(m[6] ?? 59)) : null;
  }
  return { freq, interval, until };
}

/** Add months keeping the day where it can (31 Jan + 1 month = 28/29 Feb), and the time of day. */
function addMonths(d: Date, n: number): Date {
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + n, day = d.getUTCDate();
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(day, last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()));
}

/** The occurrence after `dueAt` for an RRULE (FREQ DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, UNTIL), or null. */
export function nextOccurrence(rrule: string | null | undefined, dueAt: string | null | undefined): string | null {
  const r = parseRRule(rrule);
  if (!r || !dueAt) return null;
  const d = new Date(dueAt);
  if (Number.isNaN(d.getTime())) return null;
  const next = r.freq === "DAILY" ? new Date(d.getTime() + r.interval * 86_400_000)
    : r.freq === "WEEKLY" ? new Date(d.getTime() + r.interval * 7 * 86_400_000)
    : r.freq === "MONTHLY" ? addMonths(d, r.interval)
    : addMonths(d, 12 * r.interval);
  if (r.until !== null && next.getTime() > r.until) return null;
  return next.toISOString();
}

/** A fingerprint "kind|counterparty|about|due-day" moved to another day (other shapes are left alone). */
export function moveFingerprint(fp: string | null | undefined, dueAt: string): string | null {
  if (!fp) return null;
  const parts = fp.split("|");
  if (parts.length !== 4 || !/^\d{4}-\d{2}-\d{2}$/.test(parts[3])) return fp;
  return [...parts.slice(0, 3), dueAt.slice(0, 10)].join("|");
}

/** A change op the ledger proposes (the shape of ChangeInput in src/lib/changes, kept structural so this stays pure). */
export type LedgerOp =
  | { op: "addNode"; nodeId: string; type: "commitment"; kind: string; label: string; summary?: string; props: Record<string, unknown>; startAt: string | null; visibility: CommitmentView["visibility"]; sensitive?: boolean; note?: string; receipt?: Record<string, unknown> }
  | { op: "addEdge"; edgeId?: string; fromId: string; toId: string; relation: string; status?: "confirmed" | "unconfirmed"; note?: string; receipt?: Record<string, unknown> };

/**
 * The next occurrence of a recurring commitment that was just done, as ops for one proposal: the same commitment a
 * period later (open, nothing done yet), with the same people, other party, subject and origin. Null when it doesn't
 * recur or the rule has ended.
 */
export function rollForwardOps(c: CommitmentView, mint: () => string = randomUUIDish): LedgerOp[] | null {
  const next = nextOccurrence(c.props.recurrence, c.props.dueAt);
  if (!next) return null;
  const id = mint();
  const props: CommitmentProps = {
    direction: c.props.direction, status: "open", kind: c.props.kind, dueAt: next, dueKind: c.props.dueKind,
    recurrence: c.props.recurrence, leadDays: c.props.leadDays ?? null, amount: c.props.amount ?? null, consequence: c.props.consequence ?? null,
    fingerprint: moveFingerprint(c.props.fingerprint, next), previousId: c.id,
  };
  const receipt = { confidence: 1, locator: { note: "The next time of a recurring commitment", previousId: c.id, recurrence: c.props.recurrence } };
  const ops: LedgerOp[] = [{
    op: "addNode", nodeId: id, type: "commitment", kind: c.props.kind, label: c.label, ...(c.summary ? { summary: c.summary } : {}),
    props: props as Record<string, unknown>, startAt: next, visibility: c.visibility, ...(c.sensitive ? { sensitive: true } : {}), receipt,
  }];
  const R = COMMITMENT_RELATIONS;
  for (const p of c.responsible) ops.push({ op: "addEdge", fromId: p.id, toId: id, relation: R.responsible, status: "confirmed", receipt });
  for (const p of c.counterparty) ops.push({ op: "addEdge", fromId: id, toId: p.id, relation: R.with, status: "confirmed", receipt });
  for (const p of c.about) ops.push({ op: "addEdge", fromId: id, toId: p.id, relation: R.about, status: "confirmed", receipt });
  for (const p of c.arisesFrom) ops.push({ op: "addEdge", fromId: id, toId: p.id, relation: R.arisesFrom, status: "confirmed", receipt });
  return ops;
}

/* ── Reminders ───────────────────────────────────────────────────────────────────────────────────────── */

/**
 * When the commitment's reminder should fire: the snooze time while snoozed, else lead days before it is due, but
 * never before `now` (a reminder created late fires now) and never after it is due. Null when there is no date or it
 * is no longer open.
 */
export function reminderDueAt(p: CommitmentProps, now: Date): string | null {
  if (p.status !== "open") return null;
  if (p.snoozedUntil && Date.parse(p.snoozedUntil) > now.getTime()) return p.snoozedUntil;
  if (!p.dueAt) return null;
  const due = Date.parse(p.dueAt);
  const at = due - leadDaysOf(p) * 86_400_000;
  return new Date(Math.min(due, Math.max(at, now.getTime()))).toISOString();
}

export type ReminderLike = { id: string; nodeId: string | null; sourceId: string | null; title: string; dueAt: string; done: boolean };

const words = (s: string) => new Set(s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length >= 3));
/** Share of the shorter title's words the other has (0..1). */
export function titleOverlap(a: string, b: string): number {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}

/**
 * The reminder that already belongs to this commitment, so none is made twice: one linked to it (reminders.node_id),
 * else an unlinked open one detection made from the same source for the same day (or with nearly the same words).
 */
export function matchReminder(c: Pick<CommitmentView, "id" | "label" | "props"> & { sourceIds: string[] }, reminders: ReminderLike[], now: Date, tz = DEFAULT_TZ): ReminderLike | null {
  const linked = reminders.filter((r) => r.nodeId === c.id);
  if (linked.length) return linked.find((r) => !r.done) ?? linked[0];
  const want = reminderDueAt(c.props, now);
  const days = [c.props.dueAt, want].filter((x): x is string => !!x).map((d) => dayKey(d, tz));
  return reminders.find((r) => !r.done && !r.nodeId && r.sourceId && c.sourceIds.includes(r.sourceId)
    && (days.includes(dayKey(r.dueAt, tz)) || titleOverlap(r.title, c.label) >= 0.6)) ?? null;
}

/** What to do with the commitment's reminder now: create one, move it, close it, or nothing. */
export type ReminderPlan =
  | { action: "none" }
  | { action: "create"; dueAt: string }
  | { action: "adopt"; id: string; dueAt: string }
  | { action: "move"; id: string; dueAt: string }
  | { action: "close"; id: string }
  | { action: "reopen"; id: string; dueAt: string };

export function planReminder(c: Pick<CommitmentView, "id" | "label" | "props"> & { sourceIds: string[] }, reminders: ReminderLike[], now: Date, tz = DEFAULT_TZ): ReminderPlan {
  const have = matchReminder(c, reminders, now, tz);
  const want = reminderDueAt(c.props, now);
  if (!want) return have && !have.done && c.props.status !== "open" ? { action: "close", id: have.id } : { action: "none" };
  if (!have) return { action: "create", dueAt: want };
  if (!have.nodeId) return { action: "adopt", id: have.id, dueAt: have.dueAt === want ? have.dueAt : want };
  if (have.done) return { action: "reopen", id: have.id, dueAt: want };
  // A reminder a person moved by hand to a later day stays where they put it, as long as it is before the due date.
  const due = c.props.dueAt ? Date.parse(c.props.dueAt) : Number.POSITIVE_INFINITY;
  const at = Date.parse(have.dueAt);
  if (dayKey(have.dueAt, tz) === dayKey(want, tz) || (at > Date.parse(want) && at <= due)) return { action: "none" };
  return { action: "move", id: have.id, dueAt: want };
}

/* ── What the viewer may see ─────────────────────────────────────────────────────────────────────────── */

/**
 * Drop from a commitment everything the viewer can't read: parties whose node isn't readable and sources they can't
 * open. The commitment itself must already be readable (the store's SQL decides that).
 */
export function forViewer(c: CommitmentView, readableNodes: Set<string>, readableSources: Set<string>): CommitmentView {
  const keep = (ps: Party[]) => ps.filter((p) => readableNodes.has(p.id));
  return {
    ...c,
    responsible: keep(c.responsible), counterparty: keep(c.counterparty), about: keep(c.about), arisesFrom: keep(c.arisesFrom), clashes: keep(c.clashes),
    sources: c.sources.filter((s) => readableSources.has(s.sourceId)),
    props: { ...c.props, doneEvidenceSourceId: c.props.doneEvidenceSourceId && readableSources.has(c.props.doneEvidenceSourceId) ? c.props.doneEvidenceSourceId : null },
  };
}

/** Only commitments in the viewer's current graph whose node they may read. */
export function onlyReadable<T extends { id: string }>(list: T[], readable: Set<string>): T[] {
  return list.filter((c) => readable.has(c.id));
}

/* ── Words ───────────────────────────────────────────────────────────────────────────────────────────── */

/** "4,200 kr" / "1.250,50 kr." in the reader's locale. */
export function formatAmount(a: { value: number; currency: string } | null | undefined, locale = "en"): string | null {
  if (!a) return null;
  const cur = a.currency.toUpperCase();
  const n = new Intl.NumberFormat(locale === "da" ? "da-DK" : "en-GB", { maximumFractionDigits: a.value % 1 ? 2 : 0, minimumFractionDigits: a.value % 1 ? 2 : 0 }).format(a.value);
  if (cur === "DKK") return locale === "da" ? `${n} kr.` : `${n} kr`;
  if (cur === "EUR") return locale === "da" ? `${n} €` : `€${n}`;
  return `${n} ${cur}`;
}

/** One compact line for the assistant: "Pay the dentist bill (payment, we owe, Anna) · due Fri 14 Nov · 1,250 kr · at risk". */
export function assistantLine(c: CommitmentView, now: Date, tz = DEFAULT_TZ): string {
  const u = urgencyOf(c.props, now, tz);
  const who = c.responsible.map((p) => p.label).join(", ");
  const withWho = c.counterparty.map((p) => p.label).join(", ");
  const dir = c.props.direction === "owe" ? "we owe" : c.props.direction === "owed" ? "owed to us" : "promise";
  const due = c.props.dueAt
    ? `due ${new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(new Date(c.props.dueAt))}`
    : "no date yet";
  const bits = [
    `${c.label} (${[c.props.kind, dir, who && `responsible: ${who}`, withWho && `with ${withWho}`].filter(Boolean).join(", ")})`,
    due, formatAmount(c.props.amount), u === "overdue" ? "OVERDUE" : u === "at_risk" ? "at risk" : null,
    c.props.consequence ? `if missed: ${c.props.consequence}` : null,
  ];
  return bits.filter(Boolean).join(" · ");
}
