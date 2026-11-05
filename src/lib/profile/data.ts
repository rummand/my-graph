/**
 * The living profile of one node, for one viewer (server-only): sections from its type and kind, the graph's facts
 * as blocks in them, proposals waiting in change sets that mention it, and the written doc. Everything is read
 * through GBrain and the change-set store with the viewer, so nothing they may not see is in it.
 */
import { and, desc, eq, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { changes, changeSets } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { getChangeSets, type ChangeSetView } from "@/lib/changes";
import { loadNodeDetail } from "@/lib/gbrain/detail";
import { scopeOf } from "@/lib/graphs/pure";
import { getMeta, type Meta } from "@/lib/meta";
import { canDecideModel } from "@/lib/meta/emergent";
import { hasFeature } from "@/lib/plans";
import { presetFor } from "./presets";
import { factBlocks, sectionsFor, suggestionBlocks, type EndLike, type MetaLike } from "./sections";
import { mayWrite, ProfileError, readDoc } from "./store";
import { analysisAllowed } from "./clinical-gate";
import type { ProfileView, SectionKey } from "./types";

export function metaLike(meta: Meta): MetaLike {
  return {
    relation: (key) => meta.relations.find((r) => r.key === key),
    relationLabel: (key, dir) => meta.relationLabel(key, dir),
    kindLabel: (type, kind) => (kind ? meta.kind(type, kind)?.label ?? null : null),
  };
}

/** Draft change sets (that this viewer may see) with an op touching the node: newest first, at most `limit`. */
async function draftsMentioning(v: Viewer, nodeId: string, limit = 8): Promise<ChangeSetView[]> {
  if (!v.graphId) return [];
  const touches = or(
    eq(changes.nodeId, nodeId),
    sql`${changes.payload}->>'fromId' = ${nodeId}`, sql`${changes.payload}->>'toId' = ${nodeId}`,
    sql`${changes.payload}->>'aboutNodeId' = ${nodeId}`, sql`${changes.payload}->>'keepId' = ${nodeId}`, sql`${changes.payload}->>'dropId' = ${nodeId}`,
  );
  const rows = await db.selectDistinct({ id: changeSets.id, createdAt: changeSets.createdAt }).from(changes)
    .innerJoin(changeSets, eq(changeSets.id, changes.changeSetId))
    .where(and(eq(changeSets.graphId, v.graphId), eq(changeSets.status, "draft"), eq(changes.included, true), touches))
    .orderBy(desc(changeSets.createdAt)).limit(limit * 2);
  // getChangeSets applies who-may-see-this-proposal (its evidence must be readable to the viewer), for all at once.
  const sets = await getChangeSets(v, rows.map((r) => r.id));
  return sets.filter((cs) => cs.status === "draft").slice(0, limit);
}

export async function loadProfile(v: Viewer, nodeId: string): Promise<ProfileView> {
  const d = await loadNodeDetail(v, nodeId);
  if (!d) throw new ProfileError(404, "We couldn't find that profile.");
  const { node } = d;
  const [meta, doc, writable, insightsOn, drafts] = await Promise.all([
    getMeta(v), readDoc(v, node.id), mayWrite(v, node),
    hasFeature(v, "insights").then(async (on) => on && (await analysisAllowed(v, node))), draftsMentioning(v, node.id).catch(() => [] as ChangeSetView[]),
  ]);
  const ml = metaLike(meta);
  const defs = sectionsFor(node.type, node.kind);
  const keys = defs.map((s) => s.key);
  const subject: EndLike = { id: node.id, type: node.type, kind: node.kind ?? null };
  const neighbours = new Map<string, EndLike>(d.neighbours.map((n) => [n.id, { id: n.id, type: n.type, kind: n.kind ?? null, label: n.label }]));
  const facts = factBlocks(subject, d.edges, neighbours, ml, d.provenance.edges, keys);
  const suggestions = suggestionBlocks(subject, drafts.map((s) => ({
    id: s.id, title: s.title, origin: s.origin, status: s.status, createdAt: s.createdAt,
    changes: s.changes.map((c) => ({ id: c.id, op: c.op, summary: c.summary, nodeId: c.nodeId, included: c.included, payload: c.payload, receipt: c.receipt as Record<string, unknown> })),
  })), ml, keys);

  const sections = defs.map((s) => ({ ...s, facts: facts.filter((f) => f.section === s.key), suggestions: suggestions.filter((x) => x.section === s.key) }));
  const presets = [...new Set(defs.flatMap((s) => s.presets))].flatMap((key) => {
    const p = presetFor(key, node.type);
    return p ? [{ key, relation: p.relation, direction: p.direction, otherType: p.otherType, kind: p.kind }] : [];
  });
  const kindLabel = node.kind ? meta.kind(node.type, node.kind)?.label ?? null : null;
  return {
    node: { id: node.id, label: node.label, type: node.type, kind: node.kind ?? null, kindLabel, summary: node.summary, aliases: node.aliases, visibility: node.visibility, sensitive: node.sensitive },
    sections,
    doc,
    canEdit: writable,
    canWrite: scopeOf(v).canWrite && v.role !== "guest",
    canGrowModel: canDecideModel(v),
    insights: insightsOn && node.type === "person" && v.role !== "guest",
    presets,
    relations: relationChoices(meta, node.type),
    family: scopeOf(v).family,
  };
}

/** The relations that fit a node of this type, read from its side, family first. */
function relationChoices(meta: Meta, type: string): ProfileView["relations"] {
  const fits = (types: string[]) => types.length === 0 || types.includes(type);
  const out: ProfileView["relations"] = [];
  for (const r of meta.relations) {
    if (r.hidden) continue;
    if (fits(r.fromTypes)) out.push({ key: r.key, direction: "out", phrase: r.label, otherTypes: r.toTypes, category: r.category });
    if (!r.symmetric && fits(r.toTypes)) out.push({ key: r.key, direction: "in", phrase: r.inverseLabel, otherTypes: r.fromTypes, category: r.category });
  }
  const order = ["family", "social", "school", "care", "work", "place", "time", "document", "other"];
  return out.sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category) || a.phrase.localeCompare(b.phrase));
}

/** The section keys of a profile, for a fact's preset check. */
export function sectionKeysFor(type: string, kind: string | null): SectionKey[] {
  return sectionsFor(type, kind).map((s) => s.key);
}
