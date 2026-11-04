/**
 * Facts written on a profile (server-only). A person's own edit is a change set they author (origin "person") and
 * deliver at once, so it lands with history and provenance and can be rolled back like any other change. If it can't
 * be delivered straight away (the model needs a parent's decision, something changed), it stays as a proposal.
 */
import { randomUUID } from "node:crypto";
import type { Viewer } from "@/lib/auth";
import { deliverChangeSet, proposeChanges, type ChangeInput } from "@/lib/changes";
import { readableNodeIds } from "@/lib/gbrain";
import { getMeta } from "@/lib/meta";
import { factOps, FactError, type FactInput } from "./presets";
import { readableNode, mayWrite, ProfileError } from "./store";

export type AddFactResult = { status: "delivered" | "proposed"; changeSetId: string; otherId: string; edgeId: string; error?: string };

export async function addFact(v: Viewer, nodeId: string, input: FactInput): Promise<AddFactResult> {
  const node = await readableNode(v, nodeId);
  if (!(await mayWrite(v, node))) throw new ProfileError(403, "You can read this profile but not add to it.");
  if ("id" in input.other) {
    const ok = await readableNodeIds(v, [input.other.id]);
    if (!ok.has(input.other.id)) throw new ProfileError(404, "We couldn't find the other end of that fact.");
  }
  const meta = await getMeta(v);
  const model = {
    hasRelation: (k: string) => meta.relations.some((r) => r.key === k && !r.hidden),
    hasKind: (t: string, k: string) => !!meta.kind(t, k),
  };
  const receipt = { confidence: 1, locator: { note: "Written on the profile", profileNodeId: node.id } };
  let built: ReturnType<typeof factOps>;
  try {
    built = factOps(node.id, input, model, { mint: randomUUID, receipt });
  } catch (e) {
    if (e instanceof FactError) throw new ProfileError(400, e.message);
    throw e;
  }
  const edgeId = randomUUID();
  const ops = built.ops.map((o) => (o.op === "addEdge" ? { ...o, edgeId } : o)) as ChangeInput[];
  const otherLabel = "id" in input.other ? null : input.other.label.trim();
  const proposed = await proposeChanges(v, {
    title: `On ${node.label}'s profile`,
    description: otherLabel ? `${node.label} · ${input.relation} · ${otherLabel}` : undefined,
    origin: "person",
    evidence: { locator: { note: "Written on the profile", profileNodeId: node.id }, confidence: 1 },
    changes: ops,
  });
  if (!proposed) throw new ProfileError(403, "You can't add to this graph.");
  const r = await deliverChangeSet(v, proposed.id, {});
  if (r.ok) return { status: "delivered", changeSetId: proposed.id, otherId: built.otherId, edgeId };
  return { status: "proposed", changeSetId: proposed.id, otherId: built.otherId, edgeId, error: r.error };
}
