/**
 * Commitments: everything the household owes, is owed, or was promised — one ledger, so nothing falls through the
 * cracks. Pure contract shared by the ledger (src/lib/commitments/*.ts), detection (detect/**) and the checks that find
 * clashes and fulfilment (watch/**). No runtime dependencies.
 *
 * In the graph a commitment is a node of type "commitment" (label = one plain sentence, startAt = when it is due) with
 * these props, and these edges (relation keys are meta-model built-ins):
 *
 *   person        —responsible_for→  commitment   who has to do it (or who it is owed to, for "owed")
 *   commitment    —with→             person/org   the other party (Vejle Kommune, the landlord, Lars)
 *   commitment    —about→            any node     what it concerns (Emma, the flat, the car insurance)
 *   commitment    —arises_from→      document/rule/event/message   where it comes from (also the receipt's source)
 *   commitment    —clashes_with→     commitment/event               found by the checks, proposed like anything else
 *
 * Agents propose, humans decide: detection and the checks only PROPOSE (change sets with a receipt per op). A person
 * ticking their own commitment done, or editing it, is that person's decision and is delivered directly.
 */

/** Which way it points: we owe it, someone owes it to us, or an informal promise (either way). */
export type CommitmentDirection = "owe" | "owed" | "promise";

export type CommitmentStatus = "open" | "done" | "cancelled" | "missed";

/** What sort of thing must happen (drives icons, wording and how fulfilment is recognised). */
export type CommitmentKind =
  | "reply" // answer a letter, a form, a request (partshøring, svarfrist)
  | "payment" // pay a bill, a fee, a fine; or be paid back
  | "renewal" // something renews or expires (insurance, passport, lease, subscription)
  | "notice" // last day to give notice / cancel / object (opsigelse, klagefrist)
  | "appointment" // be somewhere at a time (indkaldelse, doctor, parent meeting)
  | "form" // sign, fill in, submit, register
  | "deliver" // bring, send, hand in (homework, documents, packed lunch)
  | "return" // give back (a borrowed thing, a deposit)
  | "other";

/** How firm the time is: a hard deadline, a fixed date, "by around", or recurring. */
export type DueKind = "deadline" | "date" | "approx" | "recurring";

export type CommitmentProps = {
  direction: CommitmentDirection;
  status: CommitmentStatus;
  kind: CommitmentKind;
  /** ISO time it is due (also the node's startAt). Null when no date is known yet ("next week" without a date). */
  dueAt: string | null;
  dueKind: DueKind;
  /** RFC 5545 RRULE for recurring ones ("FREQ=YEARLY"), with the next occurrence in dueAt. */
  recurrence?: string | null;
  /** Remind this many days before (default by kind: notice 14, renewal 30, payment 3, reply 5, others 1). */
  leadDays?: number | null;
  amount?: { value: number; currency: string } | null;
  /** What happens if it's missed, in plain words ("the insurance renews for a year at 4,200 kr"). */
  consequence?: string | null;
  /** When and how it was done (set when status becomes done). */
  doneAt?: string | null;
  doneBy?: string | null; // user id
  doneEvidenceSourceId?: string | null;
  /** Stable key for de-duplication across sources: kind|counterparty|about|due-day (see detect). */
  fingerprint?: string | null;

  /* ── Added by the ledger (additive; see docs/commitments.md) ── */
  /** Snoozed: the reminder moves to this time; the due date does not. While it is in the future it is not "at risk". */
  snoozedUntil?: string | null;
  /** Someone has started on it (a note, a reply drafted, a partial payment): it is not "at risk". */
  progressAt?: string | null;
  progressNote?: string | null;
  /** The note given when it was marked done. */
  doneNote?: string | null;
  /** When and why it was cancelled or dropped: "not_mine" | "not_a_commitment" | "duplicate" | "cancelled" (free text allowed). */
  cancelledAt?: string | null;
  cancelReason?: string | null;
  /** Recurring: the occurrence this one rolled forward from. */
  previousId?: string | null;
};

/** The ledger's grouping of open commitments by urgency (computed, never stored). */
export type CommitmentUrgency = "overdue" | "at_risk" | "this_week" | "later" | "undated";

export const COMMITMENT_RELATIONS = {
  responsible: "responsible_for",
  with: "with",
  about: "about",
  arisesFrom: "arises_from",
  clashesWith: "clashes_with",
} as const;

/** Default reminder lead time per kind, in days. */
export const DEFAULT_LEAD_DAYS: Record<CommitmentKind, number> = {
  notice: 14, renewal: 30, payment: 3, reply: 5, form: 5, appointment: 1, deliver: 1, return: 3, other: 2,
};

/** The name people see. */
export const COMMITMENTS_LABEL = { en: "Commitments", da: "Aftaler og frister" } as const;
