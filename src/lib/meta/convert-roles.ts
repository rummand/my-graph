/**
 * The role conversion for one graph (server): reads what the viewer may see, plans it (./role-conversion.ts) and opens
 * ONE change set a person delivers. Never edits the graph itself. Run per person: each member converts the people they
 * can see and change (someone else's private people are left for them).
 */
import { and, inArray, isNull, notInArray, or } from "drizzle-orm";
import { db } from "@/db";
import { edges, nodes } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { proposeChanges } from "@/lib/changes";
import { liveNodeSql } from "@/lib/gbrain";
import { canModify, visibleWhere } from "@/lib/people/access";
import { getMeta } from "./index";
import { canDecideModel, MetaError } from "./emergent";
import { planRoleConversion, type ConversionPlan, type ConvNode } from "./role-conversion";

async function load(v: Viewer) {
  const meta = await getMeta(v);
  const persons = await db.select({ id: nodes.id, type: nodes.type, kind: nodes.kind, label: nodes.label, props: nodes.props, ownerId: nodes.ownerId,
    householdId: nodes.householdId, graphId: nodes.graphId, visibility: nodes.visibility, sensitive: nodes.sensitive })
    .from(nodes).where(and(inArray(nodes.type, ["person"]), isNull(nodes.mergedInto), liveNodeSql("nodes"), visibleWhere(v, nodes)));
  const ids = persons.map((p) => p.id);
  const touching = ids.length ? await db.select({ id: edges.id, fromId: edges.fromId, toId: edges.toId, relation: edges.relation, status: edges.status }).from(edges)
    .where(and(or(inArray(edges.fromId, ids), inArray(edges.toId, ids)), notInArray(edges.status, ["rejected", "superseded"]), visibleWhere(v, edges))) : [];
  const otherIds = [...new Set(touching.flatMap((e) => [e.fromId, e.toId]))].filter((id) => !ids.includes(id));
  const others = otherIds.length ? await db.select({ id: nodes.id, type: nodes.type, kind: nodes.kind, label: nodes.label, props: nodes.props }).from(nodes)
    .where(and(inArray(nodes.id, otherIds), isNull(nodes.mergedInto), liveNodeSql("nodes"), visibleWhere(v, nodes))) : [];
  const editable = new Set(persons.filter((p) => canModify(v, p)).map((p) => p.id));
  const roles = meta.roles;
  const plan = planRoleConversion({
    nodes: [...persons, ...others] as ConvNode[], edges: touching,
    roleKeys: new Set(roles.map((r) => r.key)),
    impliedBy: new Map(roles.filter((r) => r.impliedBy).map((r) => [r.key, r.impliedBy!])),
    editable: (id) => editable.has(id),
  });
  return plan;
}

/** What the conversion would propose, without proposing it (the model page's preview). */
export async function previewRoleConversion(v: Viewer): Promise<ConversionPlan> {
  return load(v);
}

/** Propose the conversion as one change set. Returns its id, or null when there is nothing to change. */
export async function proposeRoleConversion(v: Viewer): Promise<{ changeSetId: string | null; plan: ConversionPlan }> {
  if (!canDecideModel(v)) throw new MetaError(403, "Only people who can change this graph decide about its model.");
  const plan = await load(v);
  if (!plan.changes.length) return { changeSetId: null, plan };
  const c = plan.counts;
  const parts = [
    c.people ? `${c.people} ${c.people === 1 ? "person has a kind that is" : "people have kinds that are"} really a role` : null,
    c.merged ? `${c.merged} role-only ${c.merged === 1 ? "entry is" : "entries are"} merged into the person holding the role` : null,
    c.retired ? `${c.retired} role-only ${c.retired === 1 ? "entry is" : "entries are"} retired` : null,
  ].filter(Boolean);
  const r = await proposeChanges(v, {
    title: "Kinds that are really roles", titleKey: { key: "stored.titles.rolesFromKinds", params: {} },
    description: `${parts.join("; ")}. Each role becomes a fact the person holds, with where they hold it when the graph knows. Nothing changes until you deliver it.`,
    origin: "assistant", changes: plan.changes,
  });
  return { changeSetId: r?.id ?? null, plan };
}
