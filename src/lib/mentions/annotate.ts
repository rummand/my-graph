/**
 * Live highlights for the composer (server). While someone writes, `annotate` reads the text with a fast model through
 * mux and answers what it would add: links to existing things, new things (with a kind, maybe a new kind) and facts
 * between them and "you". Nothing is written. When mux is down, existing things are still linked by name.
 *
 * On Send, `commitAnnotations` turns what the person kept into a change set (origin "chat") with a receipt per op and
 * delivers it straight away: pressing Send is the person's decision.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Viewer } from "@/lib/auth";
import { deliverChangeSet, proposeChanges, remembering, type ChangeInput, type Receipt } from "@/lib/changes";
import { addEdge, readableNodeIds, upsertNode, type NodeType } from "@/lib/gbrain";
import { scopeOf } from "@/lib/graphs/pure";
import { isMuxDown } from "@/lib/mux";
import { getMeta } from "@/lib/meta";
import { opsFromPlan, planSummary, type DomainPlan, type PlannedEntity } from "@/lib/meta/domain";
import { applyMetaOp, canDecideModel } from "@/lib/meta/emergent";
import { extractDomain, knownNodesIn, planFor } from "@/lib/meta/suggest";
import { findSynonymKind, findSynonymRelation } from "@/lib/meta/synonyms";
import { NODE_TYPE_LABELS, type MetaNodeType } from "@/lib/meta/types";
import { findWord, locateSpans, type Span } from "./markup";

export type AnnotationSpan = Span & { tone: "existing" | "new" | "newKind"; tag: string; type: string };

export type AnnotateResult = {
  spans: AnnotationSpan[];
  plan: DomainPlan;
  summary: ReturnType<typeof planSummary>;
  /** The viewer can't add to this graph: only links show. */
  readOnly: boolean;
  /** Can this person add new kinds/relations to the graph's model? (Otherwise those stay proposals.) */
  canGrowModel: boolean;
  muxDown: boolean;
  selfLabel: string;
};

const EMPTY_PLAN: DomainPlan = { kinds: [], relations: [], entities: [], facts: [], attributes: [] };

function tagOf(e: PlannedEntity): { tone: AnnotationSpan["tone"]; tag: string } {
  if (e.existing) return { tone: "existing", tag: `links to ${e.label}` };
  if (e.newKind) return { tone: "newKind", tag: `new kind: ${e.kindLabel}` };
  return { tone: "new", tag: `new ${e.kindLabel ?? NODE_TYPE_LABELS[e.type as MetaNodeType]?.one ?? "thing"}` };
}

export async function annotate(v: Viewer, input: { text: string; mentions?: { label: string; nodeId: string }[] }): Promise<AnnotateResult> {
  const text = input.text.slice(0, 4000);
  const readOnly = !scopeOf(v).canWrite;
  const meta = await getMeta(v);
  let known = await knownNodesIn(v, text);
  // Mentions the person picked are links for sure (if they can see the node).
  const picked = (input.mentions ?? []).filter((m) => z.uuid().safeParse(m.nodeId).success).slice(0, 20);
  const visible = picked.length ? await readableNodeIds(v, picked.map((m) => m.nodeId)) : new Set<string>();
  const selfLabel = known.find((k) => k.id === v.personNodeId)?.label ?? v.name;

  let muxDown = false;
  let plan: DomainPlan = EMPTY_PLAN;
  if (text.trim().length >= 12) {
    try {
      const x = await extractDomain(v, text, { route: "fast", meta, known, mode: "live", agent: "my-graph-live-highlights" });
      const r = await planFor(v, meta, x, known, text);
      plan = r.plan; known = r.known;
    } catch (e) {
      if (isMuxDown(e)) muxDown = true;
      else console.error("[annotate]", e);
    }
  }

  // Links that need no model: picked mentions and known names in the text.
  const entities = [...plan.entities];
  for (const m of picked) {
    if (!visible.has(m.nodeId) || entities.some((e) => e.nodeId === m.nodeId)) continue;
    const k = known.find((n) => n.id === m.nodeId);
    entities.push({ ref: `m-${m.nodeId}`, label: m.label, surface: `@${m.label}`, type: (k?.type ?? "thing") as MetaNodeType, kindKey: k?.kind ?? null, kindLabel: null, newKind: false, nodeId: m.nodeId, existing: true });
  }
  for (const k of known) {
    if (k.id === v.personNodeId || entities.some((e) => e.nodeId === k.id)) continue;
    if (findWord(text, k.label) < 0) continue;
    entities.push({ ref: `k-${k.id}`, label: k.label, surface: k.label, type: k.type as MetaNodeType, kindKey: k.kind ?? null, kindLabel: k.kind ? meta.kind(k.type, k.kind)?.label ?? null : null, newKind: false, nodeId: k.id, existing: true });
  }
  plan = { ...plan, entities };

  const located = locateSpans(text, entities.map((e) => ({ ref: e.ref, surface: e.surface, alternatives: [e.label, `@${e.label}`] })));
  const spans: AnnotationSpan[] = located.map((s) => {
    const e = entities.find((x) => x.ref === s.ref)!;
    return { ...s, ...tagOf(e), type: e.type };
  });
  return { spans, plan, summary: planSummary(plan), readOnly, canGrowModel: canDecideModel(v), muxDown, selfLabel };
}

/* ── Commit on Send ───────────────────────────────────────────────────────────────────────────────────── */

const ref = z.string().trim().min(1).max(60);
const label = z.string().trim().min(1).max(120);
export const commitSchema = z.object({
  text: z.string().trim().min(1).max(8000),
  conversationId: z.uuid().nullish(),
  plan: z.object({
    entities: z.array(z.object({
      ref, label, surface: z.string().max(160).default(""), type: z.enum(["person", "organization", "project", "place", "event", "topic", "thing"]),
      kindKey: z.string().max(60).nullable(), kindLabel: z.string().max(60).nullable(), newKind: z.boolean(), nodeId: z.uuid().nullable(), existing: z.boolean(),
    })).max(40),
    facts: z.array(z.object({ ref, from: ref, to: ref, relationKey: z.string().max(60), relationLabel: z.string().max(60), newRelation: z.boolean(), quote: z.string().max(300).optional() })).max(60),
    kinds: z.array(z.object({ nodeType: z.string().max(30), key: z.string().max(60), label, pluralLabel: z.string().max(120), isNew: z.boolean() })).max(40),
    relations: z.array(z.object({ key: z.string().max(60), label, inverseLabel: label, fromTypes: z.array(z.string().max(30)).max(9), toTypes: z.array(z.string().max(30)).max(9), isNew: z.boolean() })).max(40),
  }),
});
export type CommitInput = z.infer<typeof commitSchema>;

export type CommitResult = {
  changeSetId: string | null;
  /** New and linked things with their node ids, so the message can carry mention markup. */
  nodes: { ref: string; nodeId: string; label: string }[];
  applied: number;
  via: "change_set" | "direct" | "nothing";
};

export class CommitError extends Error {
  constructor(public status: 400 | 403 | 409, message: string) { super(message); }
}

/** Re-check the plan the browser sends back against the graph now: readable links, kinds and relations that exist. */
async function revalidate(v: Viewer, input: CommitInput): Promise<DomainPlan> {
  const meta = await getMeta(v);
  const ids = input.plan.entities.flatMap((e) => (e.nodeId ? [e.nodeId] : []));
  const ok = ids.length ? await readableNodeIds(v, ids) : new Set<string>();
  const kinds = new Map(input.plan.kinds.map((k) => [`${k.nodeType}:${k.key}`, k]));
  const entities: PlannedEntity[] = [];
  for (const e of input.plan.entities) {
    if (e.nodeId) { if (ok.has(e.nodeId)) entities.push({ ...e, surface: e.surface || e.label, type: e.type as MetaNodeType, existing: true, newKind: false }); continue; }
    let kindKey = e.kindKey, kindLabel = e.kindLabel, newKind = false, type = e.type as MetaNodeType;
    if (kindKey) {
      const have = meta.kind(type, kindKey);
      if (have) { kindLabel = have.label; }
      else {
        const syn = kindLabel ? findSynonymKind(meta, kindLabel, type) : null;
        if (syn?.reason === "same") { kindKey = syn.kind.key; kindLabel = syn.kind.label; type = syn.kind.nodeType; }
        else if (kinds.get(`${type}:${kindKey}`)) newKind = true;
        else { kindKey = null; kindLabel = null; }
      }
    }
    entities.push({ ...e, surface: e.surface || e.label, type, kindKey, kindLabel, newKind, nodeId: null, existing: false });
  }
  const refs = new Set(["you", ...entities.map((e) => e.ref)]);
  const rels = new Map(input.plan.relations.map((r) => [r.key, r]));
  const relations = new Map<string, DomainPlan["relations"][number]>();
  const facts: DomainPlan["facts"] = [];
  for (const f of input.plan.facts) {
    if (!refs.has(f.from) || !refs.has(f.to) || f.from === f.to) continue;
    const have = meta.relations.find((r) => r.key === f.relationKey && !r.hidden) ?? findSynonymRelation(meta, f.relationLabel)?.relation;
    if (have) {
      relations.set(have.key, { key: have.key, label: have.label, inverseLabel: have.inverseLabel, fromTypes: have.fromTypes, toTypes: have.toTypes, isNew: false });
      facts.push({ ...f, relationKey: have.key, relationLabel: have.label, newRelation: false });
    } else if (rels.get(f.relationKey)) {
      relations.set(f.relationKey, { ...rels.get(f.relationKey)!, isNew: true });
      facts.push({ ...f, newRelation: true });
    }
  }
  const usedKinds = input.plan.kinds.filter((k) => entities.some((e) => e.newKind && e.kindKey === k.key && e.type === k.nodeType))
    .map((k) => ({ ...k, nodeType: k.nodeType as MetaNodeType, isNew: true }));
  return { kinds: usedKinds, relations: [...relations.values()], entities, facts, attributes: [] };
}

export async function commitAnnotations(v: Viewer, input: CommitInput): Promise<CommitResult> {
  if (!scopeOf(v).canWrite) throw new CommitError(403, "You can look at this graph but not add to it.");
  const plan = await revalidate(v, input);
  const quoteFor = (q: string | undefined): Receipt => ({
    quote: q?.slice(0, 300), conversationId: input.conversationId ?? undefined, confidence: 1,
    locator: { messageText: input.text.slice(0, 2000), note: "Confirmed by you while writing" },
  });
  // A person who may not grow the model still adds things; their new kinds stay proposals (candidates).
  const growModel = canDecideModel(v);
  const { ops, nodeIds } = opsFromPlan(plan, { selfId: v.personNodeId, mint: randomUUID, receipt: quoteFor });
  const linked = plan.entities.filter((e) => e.nodeId).map((e) => ({ ref: e.ref, nodeId: e.nodeId!, label: e.label }));
  if (!ops.length) return { changeSetId: null, nodes: linked, applied: 0, via: "nothing" };

  const proposed = await proposeChanges(v, {
    title: "From your message", origin: "chat",
    description: input.text.slice(0, 300),
    evidence: { conversationId: input.conversationId ?? undefined, quote: input.text.slice(0, 500) },
    changes: ops as ChangeInput[],
  }).catch((e) => { console.error("[annotate] propose", e); return null; });
  if (proposed) {
    const d = await deliverChangeSet(v, proposed.id, {});
    if (d.ok) {
      const nodes = plan.entities.map((e) => ({ ref: e.ref, nodeId: nodeIds[e.ref], label: e.label })).filter((n) => n.nodeId);
      return { changeSetId: proposed.id, nodes, applied: d.applied, via: "change_set" };
    }
    if (d.conflicts.length) throw new CommitError(409, d.error ?? "Something in the graph changed while you were writing. Look again and send once more.");
    // Versioning not available yet: fall through to applying the same ops directly, with provenance.
  }
  return applyDirect(v, ops, plan, nodeIds, { growModel, changeSetId: proposed?.id ?? null });
}

/** The same ops, applied one by one through GBrain (provenance on every write) and the meta model. */
async function applyDirect(v: Viewer, ops: ReturnType<typeof opsFromPlan>["ops"], plan: DomainPlan, nodeIds: Record<string, string>, ctx: { growModel: boolean; changeSetId: string | null }): Promise<CommitResult> {
  return remembering(v, { actorKind: "person", actorName: v.name, changeSetId: ctx.changeSetId ?? undefined, context: "chat:send" }, async () => {
    const kindKey = new Map<string, string>(), relKey = new Map<string, string>(), ids = new Map<string, string>();
    let applied = 0;
    for (const op of ops) {
      const receipt = (op.receipt ?? {}) as Receipt;
      const prov = { activity: "manual_edit" as const, agentType: "user" as const, agentId: v.id, confidence: 1, quote: receipt.quote ?? null, note: "Confirmed by you while writing" };
      if (op.op === "addKind") {
        const r = await applyMetaOp(v, { op: "addKind", nodeType: String(op.nodeType), key: String(op.key), label: String(op.label), pluralLabel: op.pluralLabel as string | undefined },
          { changeSetId: ctx.changeSetId, status: ctx.growModel ? "active" : "candidate" });
        kindKey.set(`${op.nodeType}:${op.key}`, r.key); applied++;
      } else if (op.op === "addRelationType") {
        const r = await applyMetaOp(v, { op: "addRelationType", key: String(op.key), label: String(op.label), inverseLabel: String(op.inverseLabel), fromTypes: op.fromTypes as string[], toTypes: op.toTypes as string[] },
          { changeSetId: ctx.changeSetId, status: ctx.growModel ? "active" : "candidate" });
        relKey.set(String(op.key), r.key); applied++;
      } else if (op.op === "addNode") {
        const kind = op.kind ? kindKey.get(`${op.type}:${op.kind}`) ?? String(op.kind) : null;
        const { node } = await upsertNode(v, { type: op.type as NodeType, kind, label: String(op.label), props: (op.props as Record<string, unknown>) ?? {} }, prov);
        ids.set(String(op.nodeId), node.id); applied++;
      } else if (op.op === "addEdge") {
        const fromId = ids.get(String(op.fromId)) ?? String(op.fromId), toId = ids.get(String(op.toId)) ?? String(op.toId);
        try {
          await addEdge(v, { fromId, toId, relation: relKey.get(String(op.relation)) ?? String(op.relation), status: "confirmed", confidence: 1 }, prov);
          applied++;
        } catch (e) { console.error("[annotate] fact not added", e); }
      }
    }
    const nodes = plan.entities.map((e) => {
      const minted = nodeIds[e.ref];
      const id = e.nodeId ?? (minted ? ids.get(minted) : undefined);
      return id ? { ref: e.ref, nodeId: id, label: e.label } : null;
    }).filter((n): n is { ref: string; nodeId: string; label: string } => !!n);
    return { changeSetId: ctx.changeSetId, nodes, applied, via: "direct" as const };
  });
}
