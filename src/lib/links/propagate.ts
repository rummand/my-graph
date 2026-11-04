/**
 * Propagation of a change on one linked node to the others, as proposals. The orchestration takes its I/O as
 * dependencies, so the rule "propose, never write" is testable without a database: there is no write dependency.
 */
import { planPropagation, type FieldKey, type ShareableNode } from "./pure";

export type PropagationDeps = {
  /** The other active members of the node's identity (empty when it isn't linked). */
  othersOf: (nodeId: string) => Promise<{ graphId: string; nodeId: string; shareFields: FieldKey[]; linkedBy: string | null }[]>;
  /** The changed node as the changer sees it, with the fields its own membership lets travel. */
  source: () => Promise<{ graphId: string; node: ShareableNode; shareFields: FieldKey[] } | null>;
  /** Who proposes in `graphId` (a member of both graphs), or null when nobody may. */
  proposerIn: (graphId: string, linkedBy: string | null) => Promise<string | null>;
  /** The linked node as the proposer sees it in its graph, or null if they can't read it. */
  targetNode: (proposerId: string, graphId: string, nodeId: string) => Promise<ShareableNode | null>;
  /** Opens a change set in `graphId` (returns its id, or null when versioning isn't available). */
  propose: (proposerId: string, graphId: string, p: { nodeId: string; label: string; fields: FieldKey[]; set: Record<string, unknown> }) => Promise<string | null>;
  /** Folds the change into the "Update <name>" already waiting in `graphId` for this node; its id, or null if none waits. */
  amend?: (proposerId: string, graphId: string, p: { nodeId: string; label: string; fields: FieldKey[]; set: Record<string, unknown> }) => Promise<string | null>;
};

export type PropagationResult = { proposed: { graphId: string; nodeId: string; changeSetId: string; fields: FieldKey[]; folded?: boolean }[]; skipped: number };

export async function propagateChange(deps: PropagationDeps, nodeId: string, changed: FieldKey[]): Promise<PropagationResult> {
  const result: PropagationResult = { proposed: [], skipped: 0 };
  if (!changed.length) return result;
  const others = await deps.othersOf(nodeId);
  if (!others.length) return result;
  const src = await deps.source();
  if (!src) return result;
  for (const o of others) {
    if (o.graphId === src.graphId) continue;
    const proposer = await deps.proposerIn(o.graphId, o.linkedBy);
    if (!proposer) { result.skipped++; continue; }
    const target = await deps.targetNode(proposer, o.graphId, o.nodeId);
    if (!target) { result.skipped++; continue; }
    const [plan] = planPropagation({ source: src.node, sourceFields: src.shareFields, changed, targets: [{ ...o, node: target }] });
    if (!plan) continue;
    const input = { nodeId: o.nodeId, label: target.label, fields: plan.fields, set: plan.set };
    // A proposal already waiting for this node takes the newer edit; only otherwise is a new one opened.
    const folded = deps.amend ? await deps.amend(proposer, o.graphId, input) : null;
    const id = folded ?? (await deps.propose(proposer, o.graphId, input));
    if (id) result.proposed.push({ graphId: o.graphId, nodeId: o.nodeId, changeSetId: id, fields: plan.fields, ...(folded ? { folded: true } : {}) });
    else result.skipped++;
  }
  return result;
}
