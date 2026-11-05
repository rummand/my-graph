/**
 * Building the ops of a proposal that adds a commitment (pure; type-only imports). Detection, the assistant, the
 * seed script and roll-forward use it, so every commitment lands in the same shape: one node of type "commitment"
 * (label = one plain sentence, startAt = due, kind = props.kind) and its edges, each op with the receipt it rests on.
 * The ops go into `proposeChanges`; nothing is written until a person delivers them.
 */
import type { ChangeInput, Receipt } from "@/lib/changes";
import { randomUUIDish } from "./ids";
import { leadDaysOf } from "./pure";
import { COMMITMENT_RELATIONS, type CommitmentDirection, type CommitmentKind, type CommitmentProps, type DueKind } from "./types";

export type NewParty = { label: string; type: "person" | "organization" | "place" | "thing"; kind?: string | null };

export type CommitmentDraft = {
  /** One plain sentence from the household's side: "Reply to Vejle Kommune about Emma's school transport". */
  label: string;
  summary?: string;
  direction: CommitmentDirection;
  kind: CommitmentKind;
  dueAt: string | null;
  dueKind?: DueKind;
  recurrence?: string | null;
  leadDays?: number | null;
  amount?: { value: number; currency: string } | null;
  consequence?: string | null;
  fingerprint?: string | null;
  /** Existing nodes (ids the proposer has resolved and the viewer may read). */
  responsibleIds?: string[];
  withIds?: string[];
  aboutIds?: string[];
  arisesFromIds?: string[];
  /** The other party when they aren't in the graph yet (added in the same proposal). */
  newCounterparty?: NewParty | null;
  /** Default household (everyone in the graph sees what the household owes); health, money, legal → parents. */
  visibility?: "private" | "parents" | "household";
  sensitive?: boolean;
  /** The evidence every op rests on (source, chunk, quote, locator, confidence). */
  receipt?: Receipt;
  /** Why, in words, shown on the proposal. */
  note?: string;
};

/** The props stored on the node for a draft (status open, lead days from the kind unless given). */
export function draftProps(d: CommitmentDraft): CommitmentProps {
  return {
    direction: d.direction, status: "open", kind: d.kind, dueAt: d.dueAt, dueKind: d.dueKind ?? (d.recurrence ? "recurring" : "deadline"),
    recurrence: d.recurrence ?? null, leadDays: d.leadDays ?? leadDaysOf({ kind: d.kind, leadDays: null }), amount: d.amount ?? null,
    consequence: d.consequence ?? null, fingerprint: d.fingerprint ?? null,
  };
}

/**
 * The ops for one commitment. `nodeId` is minted here (returned) so callers can point more ops at it (a clash, a
 * reminder). Edge direction follows the contract: person —responsible_for→ commitment; commitment —with/about/arises_from→ x.
 */
export function commitmentOps(d: CommitmentDraft, mint: () => string = randomUUIDish): { nodeId: string; ops: ChangeInput[] } {
  const nodeId = mint();
  const receipt = d.receipt;
  const base = { ...(receipt ? { receipt } : {}), ...(d.note ? { note: d.note.slice(0, 1000) } : {}) };
  const props = draftProps(d);
  const ops: ChangeInput[] = [{
    op: "addNode", nodeId, type: "commitment", kind: d.kind, label: d.label.trim().slice(0, 200),
    ...(d.summary ? { summary: d.summary.slice(0, 2000) } : {}), props: props as Record<string, unknown>,
    startAt: d.dueAt, visibility: d.visibility ?? "household", ...(d.sensitive ? { sensitive: true } : {}), ...base,
  }];
  const R = COMMITMENT_RELATIONS;
  const edge = (fromId: string, toId: string, relation: string): ChangeInput => ({ op: "addEdge", fromId, toId, relation, ...base });
  for (const id of new Set(d.responsibleIds ?? [])) ops.push(edge(id, nodeId, R.responsible));
  for (const id of new Set(d.withIds ?? [])) ops.push(edge(nodeId, id, R.with));
  if (d.newCounterparty?.label.trim()) {
    const otherId = mint();
    ops.push({ op: "addNode", nodeId: otherId, type: d.newCounterparty.type, kind: d.newCounterparty.kind ?? null, label: d.newCounterparty.label.trim().slice(0, 200), visibility: d.visibility ?? "household", ...base });
    ops.push(edge(nodeId, otherId, R.with));
  }
  for (const id of new Set(d.aboutIds ?? [])) ops.push(edge(nodeId, id, R.about));
  for (const id of new Set(d.arisesFromIds ?? [])) ops.push(edge(nodeId, id, R.arisesFrom));
  return { nodeId, ops };
}
