/**
 * "Restore as a proposal" for a profile's graph side (server-only): how this node and its facts were at a moment,
 * proposed as a change set (origin "restore") that a person reviews and delivers. Nothing changes until then.
 */
import type { Viewer } from "@/lib/auth";
import { proposeChanges } from "@/lib/changes";
import { graphAt } from "@/lib/history/read";
import { restoreOps } from "@/lib/history/read-pure";
import { scopeToNode } from "./sections";
import { readableNode, mayWrite, ProfileError } from "./store";

export async function proposeNodeRewind(v: Viewer, nodeId: string, at: Date, title: string, note: string): Promise<{ changeSetId: string | null; ops: number }> {
  const node = await readableNode(v, nodeId);
  if (!(await mayWrite(v, node))) throw new ProfileError(403, "You can read this profile but not change it.");
  if (at.getTime() > Date.now()) throw new ProfileError(400, "Pick a moment in the past.");
  const [now, then] = await Promise.all([graphAt(v, new Date()), graphAt(v, at)]);
  const scoped = scopeToNode(now, then, node.id);
  const { ops } = restoreOps(scoped.now, scoped.then, v.id, note);
  if (!ops.length) return { changeSetId: null, ops: 0 };
  const r = await proposeChanges(v, { title, origin: "restore", changes: ops });
  return { changeSetId: r?.id ?? null, ops: ops.length };
}
