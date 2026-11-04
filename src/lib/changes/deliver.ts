/**
 * Delivering a change set (merging a branch), server-only. Only someone who may write in the graph delivers, and only
 * a set they can see. The ops are replayed onto the graph now first; a conflicted op is refused (the whole delivery
 * is), a landed one is skipped. The graph ops then apply in ONE transaction inside the history recorder, every write
 * stamped with the proposal (`change:<id>`) and a provenance row built from the op's receipt. Model ops (new kinds,
 * relation types, attributes) go first so the nodes and facts can use them; reminders and wiki pages after commit.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { changes, changeSets, sources, type Locator } from "@/db/schema";
import { audit, type Viewer } from "@/lib/auth";
import * as gbrain from "@/lib/gbrain";
import { ensureSearchIndexesOnce } from "@/lib/gbrain/setup";
import { historyStore, type HistoryScope } from "@/lib/history/context";
import { recordEvent, stampFor } from "@/lib/history/record";
import type { Receipt } from "./index";
import { fingerprintOf, verdictsFor, type ChangeRowLike } from "./pure";
import { canWrite, isId, loadRow, nowFor, type ChangeRow, type SetRow } from "./store";

export type DeliverResult = { ok: boolean; applied: number; conflicts: string[]; error?: string; stale?: boolean; skipped?: number; problems?: string[] };

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

  // Replay onto the graph now. Only the chosen ops count as "added here" for facts that need a new node.
  const chosenLike = all.map((c) => ({ ...asLike(c), included: chosen.includes(c) }));
  const now = await nowFor(v, all, chosen.some((c) => c.op === "addKind" || c.op === "addRelationType" || c.op === "addAttribute"));
  const verdicts = verdictsFor(chosenLike, now, { includedOnly: true });
  const conflicts = chosen.filter((c) => verdicts[c.id]?.verdict === "conflicted").map((c) => c.id);
  if (conflicts.length) {
    return { ok: false, applied: 0, conflicts, error: conflicts.length === 1
      ? "One change no longer fits the graph as it is now. Untick it or drop the proposal."
      : `${conflicts.length} changes no longer fit the graph as it is now. Untick them or drop the proposal.` };
  }
  const todo = chosen.filter((c) => verdicts[c.id]?.verdict !== "landed");
  const skipped = chosen.length - todo.length;

  // Receipts may only point at sources in this graph.
  const sourceIds = [...new Set(todo.map((c) => (c.receipt as Receipt)?.sourceId).filter(isId))];
  const okSources = new Set(sourceIds.length
    ? (await db.select({ id: sources.id }).from(sources).where(and(inArray(sources.id, sourceIds), eq(sources.graphId, v.graphId)))).map((s) => s.id)
    : []);

  let applied = 0;
  const problems: string[] = [];

  // 1. The model first: nodes and facts below may use what it adds. applyMetaOp records its own history.
  const kindKey = new Map<string, string>(), relKey = new Map<string, string>();
  const { applyMetaOp } = await import("@/lib/meta/emergent");
  for (const c of todo) {
    const p = c.payload as Record<string, unknown>;
    if (c.op === "addKind") {
      const r = await applyMetaOp(v, { op: "addKind", nodeType: String(p.nodeType), key: String(p.key), label: String(p.label), pluralLabel: str(p.pluralLabel), parentKey: str(p.parentKey) ?? null, description: str(p.description) },
        { changeSetId: set.id, origin: "emergent", status: "active" });
      kindKey.set(`${p.nodeType}:${p.key}`, r.key); applied++;
    } else if (c.op === "addRelationType") {
      const r = await applyMetaOp(v, { op: "addRelationType", key: String(p.key), label: String(p.label), inverseLabel: String(p.inverseLabel ?? p.label), fromTypes: p.fromTypes as string[] | undefined, toTypes: p.toTypes as string[] | undefined, symmetric: !!p.symmetric, category: str(p.category) },
        { changeSetId: set.id, origin: "emergent", status: "active" });
      relKey.set(String(p.key), r.key); applied++;
    } else if (c.op === "addAttribute") {
      await applyMetaOp(v, { op: "addAttribute", nodeType: String(p.nodeType), kindKey: str(p.kindKey) ?? null, key: String(p.key), label: String(p.label), type: String(p.type ?? "text") },
        { changeSetId: set.id, origin: "emergent", status: "active" });
      applied++;
    }
  }

  // 2. The graph: one transaction, history stamped with this proposal. (Search triggers exist before it opens, so
  //    no DDL ever waits on the delivery's own locks.)
  await ensureSearchIndexesOnce();
  const scope: HistoryScope = {
    graphId: v.graphId, actor: { kind: "person", id: v.id, name: v.name }, changeSetId: set.id, context: `change:${set.id}`, afterCommit: [], metaWatched: true,
  };
  const graphOps = todo.filter((c) => !["addKind", "addRelationType", "addAttribute", "addReminder", "editWiki"].includes(c.op));
  try {
    await historyStore.run(scope, () => db.transaction(async (tx) => {
      scope.tx = tx;
      const [locked] = await tx.select({ status: changeSets.status, fingerprint: changeSets.fingerprint }).from(changeSets).where(eq(changeSets.id, set.id)).for("update");
      if (!locked || locked.status !== "draft") throw new DeliverRefused("This proposal was decided by someone else just now.");
      if (opts.fingerprint && locked.fingerprint && locked.fingerprint !== opts.fingerprint) throw new DeliverRefused("This proposal changed after you looked at it. Look again, then deliver.", true);
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
      // Ops that weren't chosen leave the set; the set is delivered.
      if (only) {
        const left = all.filter((c) => !only.has(c.id) && c.included).map((c) => c.id);
        if (left.length) await tx.update(changes).set({ included: false }).where(inArray(changes.id, left));
      }
      const after = await tx.select().from(changes).where(eq(changes.changeSetId, set.id));
      await tx.update(changeSets).set({ status: "delivered", deliveredAt: new Date(), deliveredBy: v.id, fingerprint: fingerprintOf(after), updatedAt: new Date() })
        .where(eq(changeSets.id, set.id));
    }));
  } catch (e) {
    scope.tx = undefined;
    if (e instanceof DeliverRefused) return { ok: false, applied: 0, conflicts: [], error: e.message, stale: e.stale };
    if (e instanceof gbrain.GBrainError) return { ok: false, applied: 0, conflicts: [], error: `Nothing was delivered: ${e.message}` };
    throw e;
  }
  scope.tx = undefined;
  for (const fn of scope.afterCommit ?? []) { try { fn(); } catch { /* embeddings are best effort */ } }

  // 3. After commit: reminders and wiki pages, through their own libraries (they check access again).
  const later = todo.filter((c) => c.op === "addReminder" || c.op === "editWiki");
  if (later.length) {
    const { createReminder } = await import("@/lib/briefs");
    const wiki = await import("@/lib/wiki");
    for (const c of later) {
      const p = c.payload as Record<string, unknown>;
      try {
        if (c.op === "addReminder") {
          const due = date(p.dueAt);
          if (!due || Number.isNaN(due.getTime())) throw new Error("no date");
          await createReminder(v, { title: String(p.title ?? "").slice(0, 200), detail: str(p.detail) ?? null, dueAt: due, aboutNodeId: isId(p.aboutNodeId) ? p.aboutNodeId : null });
        } else {
          const slug = String(p.slug ?? ""), text = String(p.markdown ?? "");
          const page = slug ? await wiki.getPage(v, slug) : null;
          let pageId: string, title: string, kind: "created" | "updated";
          if (page) {
            const r = await wiki.updatePage(v, page.slug, { version: page.version, content: { ...page.content, content: [...(page.content.content ?? []), ...paragraphs(text)] } });
            pageId = r.page.id; title = r.page.title; kind = "updated";
          } else {
            const visibility = p.visibility === "parents" || p.visibility === "household" ? p.visibility : "private";
            const created = await wiki.createPage(v, { title: String(p.title ?? slug ?? "New page"), visibility, content: { type: "doc", content: paragraphs(text) } });
            pageId = created.id; title = created.title; kind = "created";
          }
          await recordEvent(db, v.graphId, { subjectType: "wiki", subjectId: pageId, subjectName: title, kind, field: "content", fromValue: null, toValue: text.slice(0, 500) },
            stampFor({ actor: { kind: "person", id: v.id, name: v.name }, changeSetId: set.id, context: `change:${set.id}` }));
        }
        applied++;
      } catch (e) {
        problems.push(c.op === "addReminder" ? `The reminder “${String(p.title ?? "")}” couldn't be added: ${(e as Error).message}` : `The wiki page couldn't be changed: ${(e as Error).message}`);
      }
    }
  }

  void audit(v, "changes.deliver", { type: "change_set", id: set.id }, { applied, skipped, title: set.title.slice(0, 120), origin: set.origin }).catch(() => {});
  return { ok: true, applied, conflicts: [], skipped, ...(problems.length ? { problems, error: problems.join(" ") } : {}) };
}

class DeliverRefused extends Error {
  constructor(message: string, public stale = false) { super(message); }
}
