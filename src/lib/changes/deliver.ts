/**
 * Delivering a change set (merging a branch), server-only. Only someone who may write in the graph delivers, and only
 * a set they can see. The ops are replayed onto the graph now first; a conflicted op is refused (the whole delivery
 * is), a landed one is skipped. The graph ops then apply in ONE transaction inside the history recorder, every write
 * stamped with the proposal (`change:<id>`) and a provenance row built from the op's receipt.
 *
 * All or nothing:
 *  - Model ops (new kinds, relation types, attributes), the graph ops and reminders apply in that ONE transaction
 *    (model first, so nodes and facts can use what it adds). If any of them fails, none of them happened.
 *  - Wiki edits can't join a transaction (the wiki library saves revisions in its own), so they run FIRST, before the
 *    transaction opens. If one fails, the ones before it are undone and nothing else is attempted; if the
 *    transaction fails afterwards, the wiki edits are undone (a created page is deleted, an edited page gets its old
 *    content back as a new revision). The wiki keeps that back-and-forth in its revision list; the graph never sees it.
 *  - Partly delivered: the ops that weren't chosen keep waiting in a follow-up set, "Rest of <title>", linked both
 *    ways through the sets' evidence (`restIn` / `restOf`), created in the same transaction.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { changes, changeSets, provenance, reminders, sources, type Locator } from "@/db/schema";
import { audit, type Viewer } from "@/lib/auth";
import * as gbrain from "@/lib/gbrain";
import { ensureSearchIndexesOnce } from "@/lib/gbrain/setup";
import { historyStore, type HistoryScope } from "@/lib/history/context";
import { recordEvent, recordMeta, snapshotMeta, stampFor } from "@/lib/history/record";
import type { Receipt } from "./index";
import { fingerprintOf, planDelivery, remapMinted, restOf, restTitle, verdictsFor, type ChangeRowLike, type OpVerdict } from "./pure";
import { applyMetaOpTx } from "./meta-tx";
import { canWrite, isId, loadRow, nowFor, type ChangeRow, type SetRow } from "./store";

export type DeliverResult = {
  ok: boolean; applied: number; conflicts: string[]; error?: string; stale?: boolean; skipped?: number; problems?: string[]; restId?: string | null;
  /** The conflicted ops' reason codes and details. */
  reasons?: Record<string, OpVerdict>;
  /** Adds that used something already in the graph, and evidence rows recorded on things already there. */
  connected?: number; evidence?: number;
};

const NODE_TYPES = new Set(["person", "place", "event", "topic", "document", "source", "organization", "project", "thing"]);
const EDGE_STATUSES = new Set(["confirmed", "unconfirmed", "inferred"]);
const HUMAN_ORIGINS = new Set(["person", "chat", "restore"]);

const asLike = (c: ChangeRow): ChangeRowLike => ({ id: c.id, seq: c.seq, op: c.op, nodeId: c.nodeId, edgeId: c.edgeId, payload: c.payload as Record<string, unknown>, included: c.included });
const str = (x: unknown) => (typeof x === "string" ? x : undefined);
const date = (x: unknown): Date | null | undefined => (x === null ? null : typeof x === "string" || x instanceof Date ? new Date(x) : undefined);

function provFor(v: Viewer, set: SetRow, c: ChangeRow, okSources: Set<string>): gbrain.ProvenanceInput {
  const r = (c.receipt ?? {}) as Receipt;
  const human = HUMAN_ORIGINS.has(set.origin);
  const sourceId = r.sourceId && okSources.has(r.sourceId) ? r.sourceId : null;
  const where = r.url && /^https?:\/\//.test(r.url) ? r.url : "";
  return {
    sourceId, chunkId: sourceId && isId(r.chunkId) ? r.chunkId : null,
    locator: { ...(r.locator && typeof r.locator === "object" ? r.locator : {}), source: `change:${set.id}`, changeSetId: set.id, changeId: c.id, ...(r.conversationId ? { conversationId: r.conversationId } : {}), ...(r.url && /^https?:\/\//.test(r.url) ? { url: r.url } : {}) } as Locator,
    quote: r.quote?.slice(0, 1000) ?? null,
    activity: human ? "manual_edit" : sourceId ? "llm_extraction" : "inference",
    agentType: human ? "user" : "model",
    agentId: human ? v.id : `change:${set.id}`,
    confidence: typeof r.confidence === "number" ? r.confidence : human ? 1 : 0.7,
    // The proposal is the source of record: `change:<id>` in the locator; the note says it in words.
    note: `Delivered by ${v.name} from the proposal “${set.title.slice(0, 120)}”.${c.note ? ` ${c.note.slice(0, 300)}` : ""}${where ? ` ${where}` : ""}`,
  };
}

function nodePatch(set: Record<string, unknown>): Partial<gbrain.NodeInput> {
  const out: Partial<gbrain.NodeInput> = {};
  if (typeof set.label === "string") out.label = set.label;
  if (typeof set.summary === "string" || set.summary === null) out.summary = (set.summary as string | null) ?? "";
  if (Array.isArray(set.aliases)) out.aliases = set.aliases.filter((a): a is string => typeof a === "string");
  if (typeof set.kind === "string" || set.kind === null) out.kind = set.kind as string | null;
  if (typeof set.type === "string" && NODE_TYPES.has(set.type)) out.type = set.type as gbrain.NodeType;
  if (set.props && typeof set.props === "object" && !Array.isArray(set.props)) out.props = set.props as Record<string, unknown>;
  if (set.startAt !== undefined) out.startAt = date(set.startAt) ?? null;
  if (set.endAt !== undefined) out.endAt = date(set.endAt) ?? null;
  if (set.visibility === "private" || set.visibility === "parents" || set.visibility === "household") out.visibility = set.visibility;
  if (typeof set.sensitive === "boolean") out.sensitive = set.sensitive;
  return out;
}

function edgePatch(set: Record<string, unknown>): gbrain.EdgePatch {
  const out: gbrain.EdgePatch = {};
  if (typeof set.relation === "string") out.relation = set.relation;
  if (typeof set.status === "string" && ["confirmed", "unconfirmed", "inferred", "rejected", "superseded"].includes(set.status)) out.status = set.status as gbrain.EdgeStatus;
  if (typeof set.confidence === "number") out.confidence = set.confidence;
  if (set.validFrom !== undefined) out.validFrom = date(set.validFrom) ?? null;
  if (set.validTo !== undefined) out.validTo = date(set.validTo) ?? null;
  if (set.visibility === "private" || set.visibility === "parents" || set.visibility === "household") out.visibility = set.visibility;
  return out;
}

function paragraphs(text: string) {
  return text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p) => ({ type: "paragraph" as const, content: [{ type: "text" as const, text: p.replace(/\n/g, " ") }] }));
}

export async function deliver(v: Viewer, id: string, opts: { onlyChangeIds?: string[]; fingerprint?: string } = {}): Promise<DeliverResult> {
  const set = await loadRow(v, id);
  if (!set) return { ok: false, applied: 0, conflicts: [], error: "We couldn't find that proposal." };
  if (set.status !== "draft") return { ok: false, applied: 0, conflicts: [], error: set.status === "delivered" ? "This proposal has already been delivered." : "This proposal was dropped." };
  if (!canWrite(v)) return { ok: false, applied: 0, conflicts: [], error: "You can look at this graph but not change it, so someone who can has to deliver this." };
  if (opts.fingerprint && set.fingerprint && opts.fingerprint !== set.fingerprint) {
    return { ok: false, applied: 0, conflicts: [], stale: true, error: "This proposal changed after you looked at it. Look again, then deliver." };
  }

  const all = await db.select().from(changes).where(eq(changes.changeSetId, set.id)).orderBy(changes.seq);
  const only = opts.onlyChangeIds ? new Set(opts.onlyChangeIds) : null;
  const chosen = all.filter((c) => (only ? only.has(c.id) : c.included));
  if (!chosen.length) return { ok: false, applied: 0, conflicts: [], error: "Tick at least one change to deliver." };

  // Replay onto the graph now. Only the chosen ops count as "added here" for facts that need a new node. An add whose
  // thing is already in the graph ("exists") is not a conflict: it is skipped, its evidence goes on the existing node,
  // and every later op that referred to the new node is pointed at the existing one. That mapping is worked out here,
  // at delivery, from the graph as it is now; it is not part of the ops, so it never makes an approval stale.
  const chosenLike = all.map((c) => ({ ...asLike(c), included: chosen.includes(c) }));
  const now = await nowFor(v, all, chosen.some((c) => c.op === "addKind" || c.op === "addRelationType" || c.op === "addAttribute"));
  const reasons = verdictsFor(chosenLike, now, { includedOnly: true, setId: set.id, baseAt: set.baseAt });
  const plan = planDelivery(chosenLike.filter((c) => c.included), reasons);
  const conflicts = plan.conflicts;
  if (conflicts.length) {
    return { ok: false, applied: 0, conflicts, reasons: Object.fromEntries(conflicts.map((id) => [id, reasons[id]])), error: conflicts.length === 1
      ? "One change needs you before this can be delivered. Open the proposal to see why."
      : `${conflicts.length} changes need you before this can be delivered. Open the proposal to see why.` };
  }
  const byId = new Map(all.map((c) => [c.id, c]));
  // The op as it will be applied: its ids pointed through the mapping (row columns kept, payload remapped).
  const todo = plan.steps.filter((x) => x.action === "apply").map((x) => ({ ...byId.get(x.change.id)!, nodeId: x.change.nodeId, payload: x.change.payload }));
  const evidenceSteps = plan.steps.filter((x): x is Extract<typeof x, { action: "evidence" }> => x.action === "evidence");
  const skipped = chosen.length - todo.length;

  // Receipts may only point at sources in this graph.
  const sourceIds = [...new Set([...todo, ...evidenceSteps.map((x) => byId.get(x.change.id)!)].map((c) => (c.receipt as Receipt)?.sourceId).filter(isId))];
  const okSources = new Set(sourceIds.length
    ? (await db.select({ id: sources.id }).from(sources).where(and(inArray(sources.id, sourceIds), eq(sources.graphId, v.graphId)))).map((s) => s.id)
    : []);

  let applied = 0, evidenceAdded = 0;
  const META = new Set(["addKind", "addRelationType", "addAttribute"]);
  const fail = (error: string, extra: Partial<DeliverResult> = {}): DeliverResult => ({ ok: false, applied: 0, conflicts: [], error, ...extra });

  // 1. Wiki edits first (they can't join the transaction); each one knows how to undo itself.
  const undo: (() => Promise<unknown>)[] = [];
  const undoWiki = async () => { for (const fn of undo.reverse()) { try { await fn(); } catch (e) { console.error("[changes] could not undo a wiki edit", e); } } };
  const wikiOps = todo.filter((c) => c.op === "editWiki");
  const wikiDone: { pageId: string; title: string; kind: "created" | "updated"; text: string }[] = [];
  if (wikiOps.length) {
    const wiki = await import("@/lib/pages");
    for (const c of wikiOps) {
      const p = c.payload as Record<string, unknown>;
      try {
        const slug = String(p.slug ?? ""), text = String(p.markdown ?? "");
        const page = slug ? await wiki.getPage(v, slug) : null;
        if (page) {
          const r = await wiki.updatePage(v, page.slug, { version: page.version, content: { ...page.content, content: [...(page.content.content ?? []), ...paragraphs(text)] } });
          const old = page.content;
          undo.push(async () => {
            const cur = await wiki.getPage(v, r.page.slug);
            if (cur) await wiki.updatePage(v, cur.slug, { version: cur.version, content: old, force: true });
          });
          wikiDone.push({ pageId: r.page.id, title: r.page.title, kind: "updated", text });
        } else {
          const visibility = p.visibility === "parents" || p.visibility === "household" ? p.visibility : "private";
          const created = await wiki.createPage(v, { title: String(p.title ?? slug ?? "New page"), visibility, content: { type: "doc", content: paragraphs(text) } });
          undo.push(() => wiki.deletePage(v, created.slug));
          wikiDone.push({ pageId: created.id, title: created.title, kind: "created", text });
        }
      } catch (e) {
        await undoWiki();
        return fail(`Nothing was delivered: the page “${String(p.title ?? p.slug ?? "")}” couldn't be changed (${(e as Error).message}).`);
      }
    }
  }

  // 2. The model, the graph and reminders: one transaction, history stamped with this proposal. (Search triggers
  //    exist before it opens, so no DDL ever waits on the delivery's own locks.)
  await ensureSearchIndexesOnce();
  const scope: HistoryScope = {
    graphId: v.graphId, actor: { kind: "person", id: v.id, name: v.name }, changeSetId: set.id, context: `change:${set.id}`, afterCommit: [], metaWatched: true,
  };
  const stamp = { actor: scope.actor, changeSetId: set.id, context: scope.context };
  const graphOps = todo.filter((c) => !META.has(c.op) && c.op !== "addReminder" && c.op !== "editWiki");
  const delivered = new Set(chosen.map((c) => c.id));
  const rest = all.filter((c) => !delivered.has(c.id));
  let restId: string | null = null;
  // Stored in English with a key ("Rest of …" → stored.titles.restOf), so each reader sees it in their own language.
  const restBase = set.title.replace(/^((Rest of|Resten af)\s+)+/i, "").trim() || set.title;
  const household = v.graphHouseholdId ?? v.householdId;
  try {
    await historyStore.run(scope, () => db.transaction(async (tx) => {
      scope.tx = tx;
      const [locked] = await tx.select({ status: changeSets.status, fingerprint: changeSets.fingerprint }).from(changeSets).where(eq(changeSets.id, set.id)).for("update");
      if (!locked || locked.status !== "draft") throw new DeliverRefused("This proposal was decided by someone else just now.");
      if (opts.fingerprint && locked.fingerprint && locked.fingerprint !== opts.fingerprint) throw new DeliverRefused("This proposal changed after you looked at it. Look again, then deliver.", true);

      // 2a. The model first: nodes and facts below may use what it adds. Its history is recorded in the same tx.
      const kindKey = new Map<string, string>(), relKey = new Map<string, string>();
      const metaOps = todo.filter((c) => META.has(c.op));
      if (metaOps.length) {
        const before = household ? await snapshotMeta(tx, household, v.graphId) : null;
        for (const c of metaOps) {
          const p = c.payload as Record<string, unknown>;
          const ctx = { changeSetId: set.id, origin: "emergent" as const, status: "active" as const };
          if (c.op === "addKind") {
            const r = await applyMetaOpTx(tx, v, { op: "addKind", nodeType: String(p.nodeType), key: String(p.key), label: String(p.label), pluralLabel: str(p.pluralLabel), parentKey: str(p.parentKey) ?? null, description: str(p.description) }, ctx);
            kindKey.set(`${p.nodeType}:${p.key}`, r.key);
          } else if (c.op === "addRelationType") {
            const r = await applyMetaOpTx(tx, v, { op: "addRelationType", key: String(p.key), label: String(p.label), inverseLabel: String(p.inverseLabel ?? p.label), fromTypes: p.fromTypes as string[] | undefined, toTypes: p.toTypes as string[] | undefined, symmetric: !!p.symmetric, category: str(p.category) }, ctx);
            relKey.set(String(p.key), r.key);
          } else {
            await applyMetaOpTx(tx, v, { op: "addAttribute", nodeType: String(p.nodeType), kindKey: str(p.kindKey) ?? null, key: String(p.key), label: String(p.label), type: String(p.type ?? "text") }, ctx);
          }
          applied++;
        }
        if (before && household) await recordMeta(tx, v.graphId, before, await snapshotMeta(tx, household, v.graphId), stamp);
      }

      // 2b. The graph.
      for (const c of graphOps) {
        const p = c.payload as Record<string, unknown>;
        const prov = provFor(v, set, c, okSources);
        switch (c.op) {
          case "addNode": {
            const type = String(p.type ?? "thing");
            if (!NODE_TYPES.has(type)) throw new DeliverRefused(`“${String(p.label ?? "")}” has a type My Graph doesn't know.`);
            const kind = typeof p.kind === "string" ? kindKey.get(`${type}:${p.kind}`) ?? p.kind : null;
            await gbrain.upsertNode(v, {
              id: c.nodeId ?? undefined, type: type as gbrain.NodeType, kind, label: String(p.label ?? ""), aliases: Array.isArray(p.aliases) ? (p.aliases as string[]) : undefined,
              summary: str(p.summary), props: (p.props as Record<string, unknown>) ?? {}, startAt: date(p.startAt) ?? null, endAt: date(p.endAt) ?? null,
              visibility: p.visibility === "private" || p.visibility === "parents" || p.visibility === "household" ? p.visibility : undefined,
              // Health and the like: kept sensitive, so it never goes to a model without no-fallback.
              ...(p.sensitive === true ? { sensitive: true } : {}),
            }, prov);
            break;
          }
          case "updateNode":
            await gbrain.updateNode(v, c.nodeId!, nodePatch((p.set as Record<string, unknown>) ?? {}), prov);
            break;
          case "retireNode":
            await gbrain.retireNode(v, c.nodeId!, prov);
            break;
          case "mergeNodes":
            await gbrain.mergeNodes(v, String(p.keepId), String(p.dropId));
            break;
          case "addEdge": {
            const status = typeof p.status === "string" && EDGE_STATUSES.has(p.status) ? (p.status as gbrain.EdgeStatus) : undefined;
            const relation = relKey.get(String(p.relation)) ?? String(p.relation);
            const e = await gbrain.addEdge(v, { id: c.edgeId ?? undefined, fromId: String(p.fromId), toId: String(p.toId), relation, confidence: typeof p.confidence === "number" ? p.confidence : undefined, status }, prov);
            // An agent's fact delivered as confirmed: the person's approval is its own provenance row, never implied.
            if (status === "confirmed" && prov.agentType === "model") await gbrain.setEdgeStatus(v, e.id, "confirmed", `Approved by ${v.name} in the proposal “${set.title.slice(0, 120)}”`);
            break;
          }
          case "updateEdge":
            await gbrain.updateEdge(v, c.edgeId!, edgePatch((p.set as Record<string, unknown>) ?? {}), prov);
            break;
          case "removeEdge":
            await gbrain.setEdgeStatus(v, c.edgeId!, "rejected", `Removed by ${v.name} in the proposal “${set.title.slice(0, 120)}”`);
            break;
        }
        applied++;
      }

      // 2c. Reminders, in the same transaction (the verdicts above already checked the node they are about; a node
      //     this proposal adds exists by now).
      for (const c of todo.filter((x) => x.op === "addReminder")) {
        const p = c.payload as Record<string, unknown>;
        const due = date(p.dueAt);
        const title = String(p.title ?? "").trim().slice(0, 200);
        if (!due || Number.isNaN(due.getTime()) || !title) throw new DeliverRefused(`The reminder “${title || "…"}” needs a title and a date.`);
        const about = isId(p.aboutNodeId) ? p.aboutNodeId : null;
        if (about && !(await gbrain.readableNodeIds(v, [about])).has(about) && !graphOps.some((g) => g.op === "addNode" && g.nodeId === about)) {
          throw new DeliverRefused(`The reminder “${title}” is about someone you can't see.`);
        }
        await tx.insert(reminders).values({
          householdId: v.graphHouseholdId, graphId: v.graphId, ownerId: v.id, title, detail: str(p.detail)?.slice(0, 2000) ?? null, dueAt: due, aboutNodeId: about, createdByKind: "user",
        });
        applied++;
      }

      // 2c'. Things already in the graph: this document's evidence goes on them (a provenance row each), so nothing it
      //      says is lost even though nothing new is written.
      for (const x of evidenceSteps) {
        const c = byId.get(x.change.id)!;
        const prov = provFor(v, set, c, okSources);
        const what = x.subject.type === "node" ? "Also named" : "Also stated";
        await tx.insert(provenance).values({
          householdId: household, graphId: v.graphId, subjectType: x.subject.type, subjectId: x.subject.id,
          sourceId: prov.sourceId ?? null, chunkId: prov.chunkId ?? null, locator: { ...(prov.locator ?? {}), alreadyInGraph: true } as Locator, quote: prov.quote ?? null,
          activity: prov.activity, agentType: prov.agentType, agentId: prov.agentId, confidence: Math.max(0, Math.min(1, prov.confidence ?? 1)),
          note: `${what} in the proposal “${set.title.slice(0, 120)}”, delivered by ${v.name}; it was already in the graph.${c.note ? ` ${c.note.slice(0, 300)}` : ""}`,
        });
        evidenceAdded++;
      }

      // 2d. What wasn't chosen keeps waiting, in "Rest of <title>". Ops there that referred to a new node which turned
      //     out to exist now refer to the existing one, so they don't read as "gone" later.
      if (rest.length) {
        const [follow] = await tx.insert(changeSets).values({
          graphId: set.graphId, title: restTitle(restBase, "Rest of"), titleKey: "stored.titles.restOf", titleParams: { title: restBase },
          description: set.description, status: "draft", origin: set.origin,
          createdBy: set.createdBy, forUserId: set.forUserId, evidence: { ...(set.evidence ?? {}), restOf: set.id, restIn: undefined },
        }).returning({ id: changeSets.id });
        restId = follow.id;
        for (const c of remapMinted(restOf(rest.map(asLike), new Set()), plan.mapping)) {
          await tx.update(changes).set({ changeSetId: follow.id, seq: c.seq, included: true, nodeId: c.nodeId, payload: c.payload }).where(eq(changes.id, c.id));
        }
        const moved = await tx.select().from(changes).where(eq(changes.changeSetId, follow.id));
        await tx.update(changeSets).set({ fingerprint: fingerprintOf(moved) }).where(eq(changeSets.id, follow.id));
      }
      const after = await tx.select().from(changes).where(eq(changes.changeSetId, set.id));
      await tx.update(changeSets).set({
        status: "delivered", deliveredAt: new Date(), deliveredBy: v.id, fingerprint: fingerprintOf(after), updatedAt: new Date(),
        ...(restId || plan.remapped.length || plan.alreadyTrue.length ? { evidence: {
          ...(set.evidence ?? {}),
          ...(restId ? { restIn: restId } : {}),
          ...(plan.remapped.length ? { remapped: plan.remapped } : {}),
          ...(plan.alreadyTrue.length ? { alreadyTrue: plan.alreadyTrue } : {}),
        } } : {}),
      }).where(eq(changeSets.id, set.id));
    }));
  } catch (e) {
    scope.tx = undefined;
    await undoWiki();
    if (e instanceof DeliverRefused) return fail(e.message, { stale: e.stale });
    if (e instanceof gbrain.GBrainError) return fail(`Nothing was delivered: ${e.message}`);
    throw e;
  }
  scope.tx = undefined;
  for (const fn of scope.afterCommit ?? []) { try { fn(); } catch { /* embeddings are best effort */ } }

  // 3. The wiki edits are kept now: note them in the graph's history.
  for (const w of wikiDone) {
    await recordEvent(db, v.graphId, { subjectType: "wiki", subjectId: w.pageId, subjectName: w.title, kind: w.kind, field: "content", fromValue: null, toValue: w.text.slice(0, 500) },
      stampFor({ actor: { kind: "person", id: v.id, name: v.name }, changeSetId: set.id, context: `change:${set.id}` }));
    applied++;
  }

  void audit(v, "changes.deliver", { type: "change_set", id: set.id }, { applied, skipped, connected: plan.remapped.length, evidence: evidenceAdded, title: set.title.slice(0, 120), origin: set.origin, restId }).catch(() => {});
  return { ok: true, applied, conflicts: [], skipped, restId, connected: plan.remapped.length, evidence: evidenceAdded };
}

class DeliverRefused extends Error {
  constructor(message: string, public stale = false) { super(message); }
}
