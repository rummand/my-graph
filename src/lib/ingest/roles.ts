/**
 * Roles from what a proposal already says about new people (pure). The extraction gives roles directly when the text
 * states them; this catches the rest: a proposed person whose name or summary carries a role word ("Dr. Mette Lund",
 * "klasselærer i 3.B") gets a role edge, unconfirmed, instead of a role being made their kind. Family words are left
 * alone (they are relations, and "Mormor" is a name). Held in a place or organisation this proposal connects them to,
 * else with no known context (the edge points back at the person).
 */
import type { ChangeInput } from "@/lib/changes";
import { detectRole, roleKeyOf, roleRelation } from "@/lib/meta/roles";
import { edgeKey } from "./proposals";

const CONTEXT_RELATIONS = new Set(["located_at", "attends", "member_of", "works_at", "works_on"]);

export function roleOpsFromPeople(changes: ChangeInput[], existingEdges: ReadonlySet<string> = new Set()): ChangeInput[] {
  const out: ChangeInput[] = [];
  const typeOf = new Map<string, string>();
  for (const c of changes) if (c.op === "addNode" && c.nodeId) typeOf.set(c.nodeId, c.type);
  const hasRole = new Set(changes.flatMap((c) => (c.op === "addEdge" && roleKeyOf(c.relation) ? [c.fromId] : [])));
  for (const c of changes) {
    if (c.op !== "addNode" || c.type !== "person" || !c.nodeId || hasRole.has(c.nodeId)) continue;
    const hit = detectRole(c.label) ?? detectRole(c.summary ?? "");
    if (!hit || hit.family) continue;
    const ctx = changes.find((x) => x.op === "addEdge" && x.fromId === c.nodeId && CONTEXT_RELATIONS.has(x.relation)
      && ["place", "organization", "project"].includes(typeOf.get(x.toId) ?? "")) as Extract<ChangeInput, { op: "addEdge" }> | undefined;
    const toId = ctx?.toId ?? c.nodeId;
    const relation = roleRelation(hit.role);
    if (existingEdges.has(edgeKey(c.nodeId, relation, toId))) continue;
    out.push({
      op: "addEdge", fromId: c.nodeId, toId, relation, confidence: 0.5, status: "unconfirmed",
      note: `Called “${hit.word}” in the text.`, receipt: { ...(c.receipt ?? {}), confidence: 0.5 },
    });
  }
  return out;
}
