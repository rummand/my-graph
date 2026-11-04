/**
 * What the MCP tools read with, in the app (server-only): GBrain, history, the library, the assistant and change sets,
 * each called with the credential's viewer (one person in one graph), so every existing access rule applies as it does
 * in My Graph itself. Writes nothing but a draft change set (propose) and nothing reaches mux but `ask`'s question.
 */
import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { proposeChanges, historyOf, type ChangeInput } from "@/lib/changes";
import * as gbrain from "@/lib/gbrain";
import { scopeOf } from "@/lib/graphs/pure";
import { whoSaidField } from "@/lib/history/read";
import { getReadableSource } from "@/lib/ingest/library";
import { getMeta } from "@/lib/meta";
import * as mux from "@/lib/mux";
import { dropUnknownCitations, extractCitations, numberContext, selectItems } from "@/lib/assistant/context";
import { longDay, timeZone } from "@/lib/assistant/dates";
import { degradedAnswer, type DegradedReason } from "@/lib/assistant/fallback";
import { voiceOf } from "@/lib/assistant/locale";
import { buildMessages } from "@/lib/assistant/prompt";
import { parseProposals } from "@/lib/assistant/proposals";
import { parseClarify } from "@/lib/assistant/clarify";
import { retrieve } from "@/lib/assistant/retrieve";
import { chooseRoute } from "@/lib/assistant/route";
import { askPerDay } from "./rate";
import type { FactOut, NodeOut, SourceRef, ToolDeps } from "./tools";

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const nodeOut = (n: gbrain.GNode): NodeOut => ({ id: n.id, type: n.type, kind: n.kind ?? null, label: n.label, summary: n.summary, startAt: iso(n.startAt), endAt: iso(n.endAt) });
const DOC_MAX = 20_000;

function sourceRefs(list: gbrain.GProvenance[], agents: Record<string, string>): SourceRef[] {
  return list.slice(0, 8).map((p) => ({
    sourceId: p.sourceId, title: p.sourceTitle, quote: p.quote, how: p.activity,
    by: p.agentType === "user" ? agents[p.agentId] ?? "a person" : p.agentType === "model" ? "the assistant" : "a rule",
    confidence: p.confidence, at: p.createdAt.toISOString(),
  }));
}

function reasonOf(e: unknown): DegradedReason {
  if (e instanceof mux.MuxAuthError) return e.type === "not_configured" ? "not_configured" : "rejected";
  if (e instanceof mux.MuxUnavailableError) return "unreachable";
  return "error";
}

export const appDeps: ToolDeps = {
  async search(v, query, limit) {
    const hits = await gbrain.search(v, query, { limit });
    return {
      nodes: hits.filter((h) => h.kind === "node" && h.node).map((h) => nodeOut(h.node!)),
      passages: hits.filter((h) => h.kind === "chunk" && h.chunk).map((h) => ({ sourceId: h.chunk!.sourceId, title: h.chunk!.sourceTitle, text: h.chunk!.text.slice(0, 1200) })),
    };
  },

  async node(v, id) {
    const node = await gbrain.getNode(v, id);
    if (!node) return null;
    const [hood, nodeProv, meta] = await Promise.all([gbrain.neighbourhood(v, node.id, 1), gbrain.explain(v, { type: "node", id: node.id }), getMeta(v)]);
    const edges = hood.edges.slice(0, 100);
    const edgeProv = await gbrain.explainEdges(v, edges.map((e) => e.id));
    const agents = await gbrain.agentNames(v, [...nodeProv, ...Object.values(edgeProv).flat()]);
    const byId = new Map(hood.nodes.map((n) => [n.id, n]));
    const facts: FactOut[] = [];
    for (const e of edges) {
      const out = e.fromId === node.id;
      const other = byId.get(out ? e.toId : e.fromId);
      if (!other) continue;
      const label = meta.relationLabel(e.relation, out ? "out" : "in");
      facts.push({
        id: e.id, says: `${node.label} ${label} ${other.label}`, relation: e.relation, direction: out ? "out" : "in",
        other: { id: other.id, label: other.label, type: other.type }, status: e.status, confidence: e.confidence,
        sources: sourceRefs(edgeProv[e.id] ?? [], agents),
      });
    }
    return {
      node: { ...nodeOut(node), aliases: node.aliases, props: node.props ?? {}, visibility: node.visibility },
      facts, sources: sourceRefs(nodeProv, agents),
    };
  },

  async people(v) {
    return (await gbrain.listNodes(v, { type: "person", limit: 500 })).map(nodeOut).sort((a, b) => a.label.localeCompare(b.label));
  },

  async timeline(v, from, to) {
    const r = await gbrain.timeline(v, { from, to, limit: 500 });
    const ids = [...new Set(r.involves.map((i) => i.personId))];
    const names = new Map<string, string>();
    for (const id of ids.slice(0, 200)) { const p = await gbrain.getNode(v, id).catch(() => null); if (p) names.set(id, p.label); }
    return r.events.map((e) => ({ ...nodeOut(e), people: r.involves.filter((i) => i.eventId === e.id).map((i) => names.get(i.personId)).filter((x): x is string => !!x) }));
  },

  async history(v, opts) {
    const events = await historyOf(v, { subjectId: opts.nodeId, since: opts.since, limit: 100 });
    return events.map((e) => ({
      at: e.at.toISOString(), what: `${e.subjectType} ${e.kind}`, subject: e.subjectName, subjectId: e.subjectId, field: e.field,
      from: e.fromValue, to: e.toValue, by: e.actorName, actor: e.actorKind, changeSetId: e.changeSetId,
    }));
  },

  async whoSaid(v, nodeId, field) {
    const b = await whoSaidField(v, nodeId, field);
    if (!b) return null;
    return {
      at: b.event.at.toISOString(), by: b.event.actorName, actor: b.event.actorKind, field: b.event.field, from: b.event.fromValue, to: b.event.toValue,
      changeSet: b.changeSet ? { id: b.changeSet.id, title: b.changeSet.title } : null, evidence: b.evidence,
    };
  },

  async document(v, id) {
    const s = await getReadableSource(v, id);
    if (!s || s.graphId !== v.graphId) return null;
    const text = s.textContent ?? "";
    return {
      id: s.id, title: s.title, kind: s.kind, mime: s.mime, date: iso(s.documentDate ?? s.createdAt), url: s.url, addedBy: s.ownerName ?? null,
      text: text.slice(0, DOC_MAX), truncated: text.length > DOC_MAX,
    };
  },

  async ask(v, question) {
    const tz = timeZone();
    const now = new Date();
    const voice = await voiceOf(v);
    const found = await retrieve(v, question, { tz, now }).catch(() => ({ items: [], hits: 0, people: [] }));
    const items = selectItems(found.items);
    const ctx = numberContext(items);
    const messages = buildMessages({
      viewerName: v.name, today: longDay(now, tz), timeZone: tz, context: ctx.text, history: [], question,
      graphKind: v.graphKind, graphName: v.graphName, locale: voice.locale, tone: "warm", memory: "", off: [], canRemember: false, unattended: true,
      hints: ["You are answering for another assistant the person connected to My Graph. Answer from the context only, cite it as [n], and do not propose changes."],
    });
    let raw: string;
    let degraded = false;
    try {
      const r = await mux.complete({
        route: chooseRoute(question, { sensitive: ctx.sensitive, contextItems: items.length }), messages, maxTokens: 1200, temperature: 0.2,
        meta: { userId: v.id, agent: "my-graph:mcp", sensitive: ctx.sensitive, graphId: v.graphId },
      });
      raw = r.text.replace(/<think>[\s\S]*?<\/think>/gi, "");
    } catch (e) {
      degraded = true;
      raw = degradedAnswer(reasonOf(e), ctx, items, voice);
    }
    const text = dropUnknownCitations(parseProposals(parseClarify(raw).text).text, ctx.citations.length).trim();
    const cited = extractCitations(text, ctx.citations);
    return {
      answer: text, degraded,
      citations: cited.map((c) => ({ n: c.n, title: c.title, sourceId: c.sourceId ?? null, nodeId: c.nodeId ?? null, quote: c.quote ?? null })),
    };
  },

  async askUsed(credentialId) {
    const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(auditLog).where(and(
      eq(auditLog.action, "mcp.call"), eq(auditLog.targetId, credentialId), sql`${auditLog.meta}->>'tool' = 'ask'`, sql`${auditLog.meta}->>'ok' = 'true'`,
      gt(auditLog.at, new Date(Date.now() - 86_400_000)),
    ));
    return r?.n ?? 0;
  },
  askLimit: () => askPerDay(),

  readable: (v, ids) => gbrain.readableNodeIds(v, ids),
  async relationKeys(v) {
    return (await getMeta(v)).relations.filter((r) => !r.hidden).map((r) => r.key);
  },
  canWrite: (v) => scopeOf(v).canWrite,

  async propose(v: Viewer, input) {
    return proposeChanges(v, {
      title: input.title, description: input.description, origin: "assistant", forUserId: input.forUserId,
      evidence: input.evidence, changes: input.changes as unknown as ChangeInput[],
    });
  },
};
