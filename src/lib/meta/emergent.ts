/**
 * The emergent meta model (server). Kinds, relations and attributes grow from what a graph learns:
 *
 *  - `recordCandidates` keeps what an agent proposed (from a source, a conversation, a description) as candidate rows
 *    for this graph, counting evidence each time the same thing turns up again. Candidates never show in pickers.
 *  - A person decides: `decideCandidate` accepts (active), merges into an existing element (retargeting the graph's
 *    nodes or edges) or hides it.
 *  - `applyMetaOp` applies an addKind / addRelationType / addAttribute op when a change set is delivered (chat Send,
 *    an approval card). The versioning workstream's deliverChangeSet should call it for those ops.
 *  - `modelOverview` feeds "How this graph sees the world": emerging, in use, quiet and the model's history.
 *
 * Everything is scoped to the viewer's current graph: a graph's own elements carry its graphId and never show in the
 * household's other graphs.
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { changes, changeSets, edges, metaAttributes, metaKinds, metaRelations, nodes } from "@/db/schema";
import { isParent, type Viewer } from "@/lib/auth";
import { historyOf, remembering } from "@/lib/changes";
import { graph as readGraph } from "@/lib/gbrain";
import { scopeOf } from "@/lib/graphs/pure";
import { getMeta, getMetaModel } from "./index";
import type { DomainPlan } from "./domain";
import { synonymPairs } from "./synonyms";
import type { MetaAttribute, MetaKind, MetaRelation } from "./types";

export class MetaError extends Error {
  constructor(public status: 400 | 403 | 404 | 409, message: string) { super(message); this.name = "MetaError"; }
}

/** Who decides about this graph's model: people who may write in it (in the family graph, parents). */
export function canDecideModel(v: Viewer): boolean {
  const s = scopeOf(v);
  if (!s.canWrite || !v.graphId) return false;
  return s.family ? isParent(v) : v.graphRole === "owner" || v.graphRole === "editor";
}

const hh = (v: Viewer) => v.graphHouseholdId ?? v.householdId;
type Table = "kinds" | "relations" | "attributes";

/* ── Keys ─────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * The household has one key namespace per table. When another graph of the household already uses a key for its own
 * element, this graph gets a suffixed key (`department__1a2b3c`) so the two never meet; labels stay the same.
 */
function graphKey(key: string, graphId: string) {
  return `${key.slice(0, 38)}__${graphId.replace(/-/g, "").slice(0, 6)}`;
}

/* ── Applying ops (delivery) ──────────────────────────────────────────────────────────────────────────── */

export type MetaOp =
  | { op: "addKind"; nodeType: string; key: string; label: string; pluralLabel?: string; parentKey?: string | null; description?: string }
  | { op: "addRelationType"; key: string; label: string; inverseLabel: string; fromTypes?: string[]; toTypes?: string[]; symmetric?: boolean; category?: string }
  | { op: "addAttribute"; nodeType: string; kindKey?: string | null; key: string; label: string; type: string };

const ATTR_TYPES = new Set(["text", "longtext", "date", "number", "boolean", "enum", "email", "phone", "url"]);

/**
 * Apply one meta op for the viewer's graph as an active element (or `status: "candidate"`). Idempotent: an element
 * with the key that this graph already sees is activated, not duplicated. Returns the key actually used, which differs
 * from the op's when another graph owns that key (callers must use it for nodes of that kind).
 */
export async function applyMetaOp(v: Viewer, op: MetaOp, ctx: { changeSetId?: string | null; origin?: "emergent" | "manual" | "template"; status?: "active" | "candidate"; evidence?: number } = {}): Promise<{ key: string; id: string; created: boolean }> {
  if (!v.graphId) throw new MetaError(403, "Pick a graph to work in first.");
  const graphId = v.graphId, household = hh(v);
  const status = ctx.status ?? "active";
  const origin = ctx.origin ?? "emergent";
  const now = new Date();
  const run = async () => db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`my-graph:meta:${household}`}))`);
    if (op.op === "addKind") {
      const nodeType = op.nodeType as never;
      const rows = await tx.select().from(metaKinds).where(and(eq(metaKinds.nodeType, nodeType), inArray(metaKinds.key, [op.key, graphKey(op.key, graphId)]),
        sql`(${metaKinds.householdId} is null or ${metaKinds.householdId} = ${household})`));
      const builtin = rows.find((r) => r.householdId === null && r.key === op.key);
      const mine = rows.find((r) => r.householdId === household && (!r.graphId || r.graphId === graphId));
      if (mine) {
        const set: Partial<typeof metaKinds.$inferInsert> = { evidenceCount: mine.evidenceCount + (ctx.evidence ?? 1) };
        if (status === "active" && mine.status !== "active" && !mine.builtin) Object.assign(set, { status: "active", changeSetId: ctx.changeSetId ?? mine.changeSetId });
        await tx.update(metaKinds).set(set).where(eq(metaKinds.id, mine.id));
        return { key: mine.key, id: mine.id, created: false };
      }
      if (builtin) return { key: builtin.key, id: builtin.id, created: false };
      const taken = rows.some((r) => r.householdId === household && r.key === op.key);
      const key = taken ? graphKey(op.key, graphId) : op.key;
      const [row] = await tx.insert(metaKinds).values({
        householdId: household, graphId, nodeType, key, label: op.label, pluralLabel: op.pluralLabel ?? null, description: op.description ?? null,
        parentKey: op.parentKey ?? null, sortOrder: 6000, builtin: false, status, origin, evidenceCount: ctx.evidence ?? 1, firstSeenAt: now,
        changeSetId: ctx.changeSetId ?? null,
      }).returning();
      return { key, id: row.id, created: true };
    }
    if (op.op === "addRelationType") {
      const rows = await tx.select().from(metaRelations).where(and(inArray(metaRelations.key, [op.key, graphKey(op.key, graphId)]),
        sql`(${metaRelations.householdId} is null or ${metaRelations.householdId} = ${household})`));
      const builtin = rows.find((r) => r.householdId === null && r.key === op.key);
      const mine = rows.find((r) => r.householdId === household && (!r.graphId || r.graphId === graphId));
      if (mine) {
        const set: Partial<typeof metaRelations.$inferInsert> = { evidenceCount: mine.evidenceCount + (ctx.evidence ?? 1) };
        if (status === "active" && mine.status !== "active" && !mine.builtin) Object.assign(set, { status: "active", changeSetId: ctx.changeSetId ?? mine.changeSetId });
        await tx.update(metaRelations).set(set).where(eq(metaRelations.id, mine.id));
        return { key: mine.key, id: mine.id, created: false };
      }
      if (builtin) return { key: builtin.key, id: builtin.id, created: false };
      const taken = rows.some((r) => r.householdId === household && r.key === op.key);
      const key = taken ? graphKey(op.key, graphId) : op.key;
      const [row] = await tx.insert(metaRelations).values({
        householdId: household, graphId, key, label: op.label, inverseLabel: op.symmetric ? op.label : op.inverseLabel, category: op.category ?? "other",
        fromTypes: op.fromTypes ?? [], toTypes: op.toTypes ?? [], symmetric: !!op.symmetric, builtin: false, status, origin,
        evidenceCount: ctx.evidence ?? 1, firstSeenAt: now, changeSetId: ctx.changeSetId ?? null,
      }).returning();
      return { key, id: row.id, created: true };
    }
    const kindKey = op.kindKey ?? null;
    const rows = await tx.select().from(metaAttributes).where(and(eq(metaAttributes.nodeType, op.nodeType as never), inArray(metaAttributes.key, [op.key, graphKey(op.key, graphId)]),
      kindKey ? eq(metaAttributes.kindKey, kindKey) : isNull(metaAttributes.kindKey), sql`(${metaAttributes.householdId} is null or ${metaAttributes.householdId} = ${household})`));
    const builtin = rows.find((r) => r.householdId === null && r.key === op.key);
    const mine = rows.find((r) => r.householdId === household && (!r.graphId || r.graphId === graphId));
    if (mine) {
      const set: Partial<typeof metaAttributes.$inferInsert> = { evidenceCount: mine.evidenceCount + (ctx.evidence ?? 1) };
      if (status === "active" && mine.status !== "active" && !mine.builtin) Object.assign(set, { status: "active", changeSetId: ctx.changeSetId ?? mine.changeSetId });
      await tx.update(metaAttributes).set(set).where(eq(metaAttributes.id, mine.id));
      return { key: mine.key, id: mine.id, created: false };
    }
    if (builtin) return { key: builtin.key, id: builtin.id, created: false };
    const taken = rows.some((r) => r.householdId === household && r.key === op.key);
    const key = taken ? graphKey(op.key, graphId) : op.key;
    const [row] = await tx.insert(metaAttributes).values({
      householdId: household, graphId, nodeType: op.nodeType as never, kindKey, key, label: op.label,
      dataType: (ATTR_TYPES.has(op.type) ? op.type : "text") as never, options: [], required: false, sensitive: false, sortOrder: 6000, builtin: false,
      status, origin, evidenceCount: ctx.evidence ?? 1, firstSeenAt: now, changeSetId: ctx.changeSetId ?? null,
    }).returning();
    return { key, id: row.id, created: true };
  });
  return remembering(v, { actorKind: origin === "emergent" && status === "candidate" ? "assistant" : "person", actorName: v.name, changeSetId: ctx.changeSetId ?? undefined, context: `meta:${op.op}` }, run);
}

/**
 * Keep an agent's proposed model elements as candidates of this graph (evidence +1 each time one turns up again).
 * Only new kinds/relations/attributes of the plan; reused ones need nothing.
 */
export async function recordCandidates(v: Viewer, plan: DomainPlan, ctx: { changeSetId?: string | null } = {}): Promise<number> {
  if (!v.graphId) return 0;
  let n = 0;
  for (const k of plan.kinds.filter((k) => k.isNew)) {
    await applyMetaOp(v, { op: "addKind", nodeType: k.nodeType, key: k.key, label: k.label, pluralLabel: k.pluralLabel }, { ...ctx, status: "candidate" }); n++;
  }
  for (const r of plan.relations.filter((r) => r.isNew)) {
    await applyMetaOp(v, { op: "addRelationType", key: r.key, label: r.label, inverseLabel: r.inverseLabel, fromTypes: r.fromTypes, toTypes: r.toTypes }, { ...ctx, status: "candidate" }); n++;
  }
  for (const a of plan.attributes.filter((a) => a.newAttribute)) {
    const e = plan.entities.find((e) => e.ref === a.ref);
    if (!e) continue;
    await applyMetaOp(v, { op: "addAttribute", nodeType: e.type, kindKey: e.newKind ? null : e.kindKey, key: a.key, label: a.label, type: a.dataType }, { ...ctx, status: "candidate" }); n++;
  }
  return n;
}

/* ── Deciding about candidates ────────────────────────────────────────────────────────────────────────── */

const tables = { kinds: metaKinds, relations: metaRelations, attributes: metaAttributes } as const;

async function ownRow(v: Viewer, table: Table, id: string) {
  const t = tables[table];
  const [row] = await db.select().from(t).where(and(eq(t.id, id), eq(t.householdId, hh(v))));
  if (!row || (row.graphId && row.graphId !== v.graphId)) throw new MetaError(404, "That isn't part of this graph's model.");
  return row;
}

/**
 * accept → active; hide → hidden; merge → the graph's nodes (kinds) or facts (relations) using it move to `intoKey`,
 * and the candidate is hidden. Merging needs an element this graph already sees.
 */
export async function decideCandidate(v: Viewer, input: { table: Table; id: string; action: "accept" | "hide" | "merge" | "restore"; intoKey?: string }): Promise<{ ok: true; moved: number }> {
  if (!canDecideModel(v)) throw new MetaError(403, "Only people who can change this graph decide about its model.");
  const row = await ownRow(v, input.table, input.id);
  if (row.builtin) throw new MetaError(400, "Built-ins are changed in the editor below.");
  const t = tables[input.table];
  const graphId = v.graphId;
  let moved = 0;
  await remembering(v, { actorKind: "person", actorName: v.name, context: `meta:${input.action}` }, async () => {
    if (input.action === "accept" || input.action === "restore") {
      await db.update(t).set({ status: "active", graphId: row.graphId ?? graphId }).where(eq(t.id, row.id));
      return;
    }
    if (input.action === "hide") {
      await db.update(t).set({ status: "hidden" }).where(eq(t.id, row.id));
      return;
    }
    const into = input.intoKey?.trim();
    if (!into || into === row.key) throw new MetaError(400, "Choose what to merge it into.");
    const meta = await getMeta(v);
    if (input.table === "kinds") {
      const k = row as typeof metaKinds.$inferSelect;
      const target = meta.kinds.find((x) => x.key === into && x.nodeType === k.nodeType && !x.hidden);
      if (!target) throw new MetaError(400, "Merge into a kind of the same type that this graph uses.");
      const r = await db.update(nodes).set({ kind: target.key, updatedAt: new Date() })
        .where(and(eq(nodes.graphId, graphId), eq(nodes.type, k.nodeType), eq(nodes.kind, k.key))).returning({ id: nodes.id });
      moved = r.length;
    } else if (input.table === "relations") {
      const target = meta.relations.find((x) => x.key === into && !x.hidden);
      if (!target) throw new MetaError(400, "Merge into a relation this graph uses.");
      const r = await db.update(edges).set({ relation: target.key }).where(and(eq(edges.graphId, graphId), eq(edges.relation, row.key))).returning({ id: edges.id });
      moved = r.length;
    } else {
      const a = row as typeof metaAttributes.$inferSelect;
      const target = meta.attributes.find((x) => x.key === into && x.nodeType === a.nodeType && !x.hidden);
      if (!target) throw new MetaError(400, "Merge into a detail of the same type that this graph uses.");
      const r = await db.execute<{ id: string }>(sql`update nodes set props = (props - ${a.key}) || jsonb_build_object(${target.key}::text, props -> ${a.key}), updated_at = now()
        where graph_id = ${graphId} and type = ${a.nodeType} and props ? ${a.key} and not (props ? ${target.key}) returning id`);
      moved = r.length;
    }
    await db.update(t).set({ status: "hidden" }).where(eq(t.id, row.id));
  });
  return { ok: true, moved };
}

/* ── The overview ("How this graph sees the world") ───────────────────────────────────────────────────── */

export type Evidence = { quote: string | null; sourceId: string | null; conversationId: string | null; url: string | null; changeSetId: string; at: string; origin: string };

export type ModelElement = {
  table: Table; id: string; key: string; label: string; detail: string | null; nodeType: string | null;
  status: string; source: string; usage: number; examples: { id: string; label: string }[]; evidenceCount: number;
  evidence: Evidence[]; firstSeenAt: string | null; graphOnly: boolean; origin: string;
  /** For candidates: existing elements it probably is (synonyms). */
  sameAs: { key: string; label: string }[];
};

export type ModelHistoryEntry = { at: string; what: string; label: string; table: Table | "other"; how: string; changeSetId: string | null };

export type ModelOverview = {
  graphName: string; canDecide: boolean;
  emerging: ModelElement[]; inUse: ModelElement[]; quiet: ModelElement[]; history: ModelHistoryEntry[];
};

/** Receipts for proposed meta ops in this graph, by "table:key". */
async function evidenceFor(graphId: string): Promise<Map<string, Evidence[]>> {
  const rows = await db.select({ op: changes.op, payload: changes.payload, receipt: changes.receipt, setId: changes.changeSetId, at: changes.createdAt, origin: changeSets.origin, evidence: changeSets.evidence })
    .from(changes).innerJoin(changeSets, eq(changeSets.id, changes.changeSetId))
    .where(and(eq(changes.graphId, graphId), inArray(changes.op, ["addKind", "addRelationType", "addAttribute"])))
    .orderBy(desc(changes.createdAt)).limit(400);
  const out = new Map<string, Evidence[]>();
  for (const r of rows) {
    const table: Table = r.op === "addKind" ? "kinds" : r.op === "addRelationType" ? "relations" : "attributes";
    const key = `${table}:${String(r.payload.key ?? "")}`;
    const rc = r.receipt as Record<string, unknown>, ev = r.evidence as Record<string, unknown>;
    const list = out.get(key) ?? [];
    if (list.length < 5) list.push({
      quote: typeof rc.quote === "string" ? rc.quote : null, sourceId: (rc.sourceId ?? ev.sourceId ?? null) as string | null,
      conversationId: (rc.conversationId ?? ev.conversationId ?? null) as string | null, url: (rc.url ?? null) as string | null,
      changeSetId: r.setId, at: r.at.toISOString(), origin: r.origin,
    });
    out.set(key, list);
  }
  return out;
}

export async function modelOverview(v: Viewer): Promise<ModelOverview> {
  const model = await getMetaModel(v);
  const g = await readGraph(v, { limit: 1000 }).catch(() => ({ nodes: [], edges: [] }));
  const kindUse = new Map<string, { id: string; label: string }[]>();
  for (const n of g.nodes) if (n.kind) {
    const k = `${n.type}:${n.kind}`;
    kindUse.set(k, [...(kindUse.get(k) ?? []), { id: n.id, label: n.label }]);
  }
  const relUse = new Map<string, number>();
  for (const e of g.edges) relUse.set(e.relation, (relUse.get(e.relation) ?? 0) + 1);
  const attrUse = new Map<string, number>();
  for (const n of g.nodes) for (const key of Object.keys(n.props ?? {})) attrUse.set(`${n.type}:${key}`, (attrUse.get(`${n.type}:${key}`) ?? 0) + 1);

  const evidence = v.graphId ? await evidenceFor(v.graphId).catch(() => new Map<string, Evidence[]>()) : new Map<string, Evidence[]>();
  const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

  const kindEl = (k: MetaKind): ModelElement => {
    const ex = kindUse.get(`${k.nodeType}:${k.key}`) ?? [];
    return { table: "kinds", id: k.householdRowId ?? k.id, key: k.key, label: k.label, detail: k.description, nodeType: k.nodeType, status: k.status ?? "active",
      source: k.source ?? "builtin", usage: ex.length, examples: ex.slice(0, 4), evidenceCount: k.evidenceCount ?? 0, evidence: evidence.get(`kinds:${k.key}`) ?? [],
      firstSeenAt: iso(k.firstSeenAt ?? k.createdAt), graphOnly: !!k.graphId, origin: k.origin, sameAs: [] };
  };
  const relEl = (r: MetaRelation): ModelElement => ({
    table: "relations", id: r.householdRowId ?? r.id, key: r.key, label: r.label, detail: r.symmetric ? null : `Read back: ${r.inverseLabel}`, nodeType: null,
    status: r.status ?? "active", source: r.source ?? "builtin", usage: relUse.get(r.key) ?? 0, examples: [], evidenceCount: r.evidenceCount ?? 0,
    evidence: evidence.get(`relations:${r.key}`) ?? [], firstSeenAt: iso(r.firstSeenAt ?? r.createdAt), graphOnly: !!r.graphId, origin: r.origin, sameAs: [],
  });
  const attrEl = (a: MetaAttribute): ModelElement => ({
    table: "attributes", id: a.householdRowId ?? a.id, key: a.key, label: a.label, detail: null, nodeType: a.nodeType, status: a.status ?? "active",
    source: a.source ?? "builtin", usage: attrUse.get(`${a.nodeType}:${a.key}`) ?? 0, examples: [], evidenceCount: a.evidenceCount ?? 0,
    evidence: evidence.get(`attributes:${a.key}`) ?? [], firstSeenAt: iso(a.firstSeenAt ?? a.createdAt), graphOnly: !!a.graphId, origin: a.origin, sameAs: [],
  });

  // Emerging: candidates, with the elements they are probably the same as.
  const c = model.candidates ?? { kinds: [], relations: [], attributes: [] };
  const emerging = [...c.kinds.map(kindEl), ...c.relations.map(relEl), ...c.attributes.map(attrEl)];
  const active = { kinds: model.kinds.filter((k) => !k.hidden), relations: model.relations.filter((r) => !r.hidden) };
  for (const e of emerging) {
    const pool = e.table === "kinds" ? active.kinds.filter((k) => k.nodeType === e.nodeType).map((k) => ({ id: k.key, label: k.label }))
      : e.table === "relations" ? active.relations.map((r) => ({ id: r.key, label: r.label })) : [];
    e.sameAs = synonymPairs([{ id: "__me", label: e.label }, ...pool]).filter((p) => p.a === "__me").map((p) => pool.find((x) => x.id === p.b)!).map((x) => ({ key: x.id, label: x.label })).slice(0, 3);
  }
  emerging.sort((a, b) => b.evidenceCount - a.evidenceCount || a.label.localeCompare(b.label));

  const all = [
    ...model.kinds.filter((k) => !k.hidden || (kindUse.get(`${k.nodeType}:${k.key}`)?.length ?? 0) > 0).map(kindEl),
    ...model.relations.filter((r) => !r.hidden || (relUse.get(r.key) ?? 0) > 0).map(relEl),
    ...model.attributes.filter((a) => !a.hidden && a.source !== "builtin").map(attrEl),
  ];
  const inUse = all.filter((e) => e.usage > 0).sort((a, b) => b.usage - a.usage);
  const quiet = all.filter((e) => e.usage === 0 && e.table !== "attributes");

  // History: when each element appeared (from the rows), plus recorded model events.
  const own = [...model.kinds, ...model.relations, ...model.attributes, ...c.kinds, ...c.relations, ...c.attributes].filter((x) => x.householdRowId && x.source !== "builtin");
  const history: ModelHistoryEntry[] = own.map((x) => {
    const table: Table = "nodeType" in x ? ("kindKey" in x ? "attributes" : "kinds") : "relations";
    const how = x.source === "template" ? "Came with this graph's template"
      : x.source === "emergent" ? (x.status === "candidate" ? "Proposed from what this graph learned" : x.status === "hidden" ? "Proposed, then hidden" : "Grew from what this graph learned")
      : "Added by hand";
    return { at: iso(x.firstSeenAt ?? x.createdAt) ?? new Date(0).toISOString(), what: table === "kinds" ? "Kind" : table === "relations" ? "Relation" : "Detail", label: x.label, table, how, changeSetId: x.changeSetId ?? null };
  });
  const events = await historyOf(v, { limit: 200 }).catch(() => []);
  for (const e of events.filter((e) => e.subjectType === "meta")) {
    history.push({ at: new Date(e.at).toISOString(), what: e.kind === "created" ? "Added" : e.kind.charAt(0).toUpperCase() + e.kind.slice(1), label: e.subjectName ?? "", table: "other",
      how: e.actorName ? `by ${e.actorName}` : e.context ?? "", changeSetId: e.changeSetId });
  }
  history.sort((a, b) => b.at.localeCompare(a.at));

  return { graphName: v.graphName, canDecide: canDecideModel(v), emerging, inUse, quiet, history: history.slice(0, 60) };
}
