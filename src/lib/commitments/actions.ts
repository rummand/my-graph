/**
 * What a person does on a commitment (server-only): mark it done, reopen it, snooze it, say they have started,
 * reassign it, edit its date/amount/consequence, or drop it. Each is that person's own decision, so it is a change
 * set they author (origin "person") and deliver at once — it lands with history and provenance like any change and
 * can be rolled back. When it can't be delivered straight away (they may read the commitment but not change it,
 * or something changed meanwhile) it stays waiting as a proposal for someone who may.
 *
 * Only route handlers call these, when a person presses a button (or approves the Ask window's card for it).
 * Detection and the checks never do: they propose (see ops.ts).
 */
import type { Viewer } from "@/lib/auth";
import { deliverChangeSet, proposeChanges, type ChangeInput, type Receipt } from "@/lib/changes";
import { readableNodeIds } from "@/lib/gbrain";
import { scopeOf } from "@/lib/graphs/pure";
import { rollForwardOps, type CommitmentView } from "./pure";
import { syncReminders } from "./reminders";
import { getCommitment, sourceReadable } from "./store";
import { COMMITMENT_RELATIONS, type CommitmentProps } from "./types";

export class CommitmentError extends Error {
  constructor(public status: 400 | 403 | 404 | 409, message: string) {
    super(message);
    this.name = "CommitmentError";
  }
}

export type ActionResult = {
  status: "delivered" | "proposed";
  changeSetId: string;
  error?: string;
  /** Recurring and done: the proposal with the next time, waiting for a person. */
  nextProposalId?: string | null;
  commitment: CommitmentView | null;
};

export type CommitmentAction =
  | { action: "done"; note?: string; evidenceSourceId?: string }
  | { action: "reopen" }
  | { action: "snooze"; until: string }
  | { action: "progress"; note?: string }
  | { action: "reassign"; personId: string }
  | { action: "edit"; label?: string; dueAt?: string | null; amount?: { value: number; currency: string } | null; consequence?: string | null; leadDays?: number | null; recurrence?: string | null }
  | { action: "cancel"; reason?: "not_mine" | "not_a_commitment" | "duplicate" | "cancelled"; note?: string };

const RECEIPT: Receipt = { confidence: 1, locator: { note: "Changed on the commitments page" } };

async function load(v: Viewer, id: string): Promise<CommitmentView> {
  if (!scopeOf(v).canWrite || v.role === "guest") throw new CommitmentError(403, "You can look at this graph but not change it.");
  const c = await getCommitment(v, id);
  if (!c) throw new CommitmentError(404, "We couldn't find that commitment.");
  return c;
}

const setProps = (c: CommitmentView, props: Partial<CommitmentProps>, extra: Record<string, unknown> = {}, receipt: Receipt = RECEIPT): ChangeInput =>
  ({ op: "updateNode", nodeId: c.id, set: { props, ...extra }, receipt });

/** Propose as the person, then deliver as the person. */
async function decide(v: Viewer, c: CommitmentView, title: { en: string; key: string; params: Record<string, string> }, changes: ChangeInput[]): Promise<{ status: "delivered" | "proposed"; changeSetId: string; error?: string }> {
  const proposed = await proposeChanges(v, {
    title: title.en, titleKey: { key: `stored.titles.${title.key}`, params: title.params }, origin: "person",
    evidence: { locator: { note: "Changed on the commitments page", commitmentId: c.id }, confidence: 1 }, changes,
  });
  if (!proposed) throw new CommitmentError(403, "You can't change this graph.");
  const r = await deliverChangeSet(v, proposed.id, {});
  return r.ok ? { status: "delivered", changeSetId: proposed.id } : { status: "proposed", changeSetId: proposed.id, error: r.error };
}

export async function actOnCommitment(v: Viewer, id: string, a: CommitmentAction, now = new Date()): Promise<ActionResult> {
  const c = await load(v, id);
  const label = c.label.slice(0, 80);
  const iso = now.toISOString();
  let res: { status: "delivered" | "proposed"; changeSetId: string; error?: string };
  let next: string | null = null;

  switch (a.action) {
    case "done": {
      if (c.props.status === "done") throw new CommitmentError(409, "This is already done.");
      let receipt = RECEIPT;
      if (a.evidenceSourceId) {
        if (!(await sourceReadable(v, a.evidenceSourceId))) throw new CommitmentError(404, "We couldn't find that file.");
        receipt = { ...RECEIPT, sourceId: a.evidenceSourceId };
      }
      res = await decide(v, c, { en: `Done: ${label}`, key: "commitmentDone", params: { label } }, [setProps(c, {
        status: "done", doneAt: iso, doneBy: v.id, doneNote: a.note?.trim().slice(0, 500) || null, doneEvidenceSourceId: a.evidenceSourceId ?? null, snoozedUntil: null,
      }, {}, receipt)]);
      // Recurring: the next time is proposed (never added by itself), for a person to deliver.
      if (res.status === "delivered") {
        const ops = rollForwardOps(c);
        if (ops) {
          const p = await proposeChanges(v, {
            title: `Next time: ${label}`, titleKey: { key: "stored.titles.commitmentNext", params: { label } }, origin: "assistant",
            description: `“${label}” repeats (${c.props.recurrence}). This is the next time.`,
            evidence: { locator: { note: "The next time of a recurring commitment", previousId: c.id }, confidence: 1 },
            changes: ops as ChangeInput[],
          }).catch((e) => { console.error("[commitments] next occurrence not proposed", e); return null; });
          next = p?.id ?? null;
        }
      }
      break;
    }
    case "reopen":
      res = await decide(v, c, { en: `Reopened: ${label}`, key: "commitmentReopen", params: { label } }, [setProps(c, {
        status: "open", doneAt: null, doneBy: null, doneNote: null, doneEvidenceSourceId: null, cancelledAt: null, cancelReason: null,
      })]);
      break;
    case "snooze": {
      const until = new Date(a.until);
      if (Number.isNaN(until.getTime()) || until.getTime() <= now.getTime()) throw new CommitmentError(400, "Pick a time in the future.");
      if (c.props.dueAt && until.getTime() > Date.parse(c.props.dueAt)) throw new CommitmentError(400, "That is after it is due. Change the due date instead.");
      res = await decide(v, c, { en: `Snoozed: ${label}`, key: "commitmentSnooze", params: { label } }, [setProps(c, { snoozedUntil: until.toISOString() })]);
      break;
    }
    case "progress":
      res = await decide(v, c, { en: `Started: ${label}`, key: "commitmentProgress", params: { label } }, [setProps(c, { progressAt: iso, progressNote: a.note?.trim().slice(0, 500) || null })]);
      break;
    case "reassign": {
      if (!(await readableNodeIds(v, [a.personId])).has(a.personId)) throw new CommitmentError(404, "We couldn't find that person.");
      if (c.responsible.length === 1 && c.responsible[0].id === a.personId) throw new CommitmentError(409, "They are already the one responsible.");
      const ops: ChangeInput[] = c.responsible.filter((p) => p.edgeId && p.id !== a.personId).map((p) => ({ op: "removeEdge", edgeId: p.edgeId!, receipt: RECEIPT }));
      if (!c.responsible.some((p) => p.id === a.personId)) {
        ops.push({ op: "addEdge", fromId: a.personId, toId: c.id, relation: COMMITMENT_RELATIONS.responsible, status: "confirmed", receipt: RECEIPT });
      }
      res = await decide(v, c, { en: `Reassigned: ${label}`, key: "commitmentReassign", params: { label } }, ops);
      break;
    }
    case "edit": {
      const props: Partial<CommitmentProps> = {};
      const extra: Record<string, unknown> = {};
      if (a.dueAt !== undefined) {
        const d = a.dueAt ? new Date(a.dueAt) : null;
        if (d && Number.isNaN(d.getTime())) throw new CommitmentError(400, "That date isn't valid.");
        props.dueAt = d ? d.toISOString() : null;
        extra.startAt = props.dueAt;
        // A new date starts the warning over.
        props.snoozedUntil = null;
      }
      if (a.amount !== undefined) props.amount = a.amount;
      if (a.consequence !== undefined) props.consequence = a.consequence?.trim().slice(0, 500) || null;
      if (a.leadDays !== undefined) props.leadDays = a.leadDays;
      if (a.recurrence !== undefined) props.recurrence = a.recurrence;
      if (a.label !== undefined) {
        if (!a.label.trim()) throw new CommitmentError(400, "Say what has to happen.");
        extra.label = a.label.trim().slice(0, 200);
      }
      if (!Object.keys(props).length && !Object.keys(extra).length) throw new CommitmentError(400, "Nothing to change.");
      res = await decide(v, c, { en: `Changed: ${label}`, key: "commitmentEdit", params: { label } }, [setProps(c, props, extra)]);
      break;
    }
    case "cancel":
      if (c.props.status === "cancelled") throw new CommitmentError(409, "This is already dropped.");
      res = await decide(v, c, { en: `Dropped: ${label}`, key: "commitmentCancel", params: { label } }, [{
        ...setProps(c, { status: "cancelled", cancelledAt: iso, cancelReason: a.reason ?? "cancelled", snoozedUntil: null }),
        ...(a.note ? { note: a.note.slice(0, 500) } : {}),
      }]);
      break;
  }

  const after = await getCommitment(v, id);
  if (after && res.status === "delivered") await syncReminders(v, [after], now);
  return { ...res, nextProposalId: next, commitment: after };
}
