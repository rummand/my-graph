/**
 * At risk (pure): an open commitment is at risk when it is due within its lead time and there has been no progress
 * signal since it appeared — no message or document about it (same thread, the other party, a source linked to it),
 * no progress noted, not snoozed. The ledger's `urgencyOf` (../pure) owns the grouping; this adds the graph's own
 * signals to it: `withSignal` folds the newest signal into the props as `progressAt`, so `urgencyOf` sees it.
 *
 * Appointments are never at risk on their own (nothing to do before them but turn up); overdue is the ledger's.
 */
import { daysUntil, leadDaysOf, urgencyOf, DEFAULT_TZ } from "../pure";
import type { CommitmentProps, CommitmentUrgency } from "../types";

export type ProgressSignal = {
  /** When the newest related message/document/edit happened (after the commitment appeared), or null. */
  at: string | null;
  /** What it was, for the ledger's hint ("Reply from Vejle Kommune", "You edited it"). */
  what?: string | null;
  sourceId?: string | null;
};

export type RiskVerdict = {
  atRisk: boolean;
  urgency: CommitmentUrgency | null;
  /** Days left until it is due (0 = today), null when undated. */
  daysLeft: number | null;
  /** Why: "no_progress" when at risk; "progress" when a signal keeps it off the list. */
  reason: "no_progress" | "progress" | "snoozed" | null;
};

/** Props with the newest progress signal folded in (only one after it appeared counts). */
export function withSignal(p: CommitmentProps, appearedAt: string | Date, signal: ProgressSignal | null | undefined): CommitmentProps {
  if (!signal?.at) return p;
  const at = Date.parse(signal.at);
  if (!Number.isFinite(at) || at <= new Date(appearedAt).getTime()) return p;
  const cur = p.progressAt ? Date.parse(p.progressAt) : 0;
  return at > cur ? { ...p, progressAt: new Date(at).toISOString() } : p;
}

/** Is it at risk, and why — the ledger and Today call this with the signals from `progressSignals` (server). */
export function assessRisk(p: CommitmentProps, appearedAt: string | Date, signal: ProgressSignal | null | undefined, now: Date, tz = DEFAULT_TZ): RiskVerdict {
  const props = withSignal(p, appearedAt, signal);
  const urgency = urgencyOf(props, now, tz);
  const daysLeft = props.dueAt ? daysUntil(props.dueAt, now, tz) : null;
  if (urgency === "at_risk") return { atRisk: true, urgency, daysLeft, reason: "no_progress" };
  const within = daysLeft !== null && daysLeft >= 0 && daysLeft <= leadDaysOf(props) && props.status === "open" && props.kind !== "appointment";
  const snoozed = !!props.snoozedUntil && Date.parse(props.snoozedUntil) > now.getTime();
  return { atRisk: false, urgency, daysLeft, reason: within ? (snoozed ? "snoozed" : "progress") : null };
}
