/**
 * Rules as part of the graph (server-only). When a person approves rules or definitions on a rule set's page, they
 * become nodes through the normal change-set path: one change set ("Rules of <rule set>") with a receipt on every op
 * (the source, the exact passage, its place, the official page), delivered by that person in the same action — their
 * approval is the decision. Each rule is a node (document, kind rule) part of the rule set's node; a definition is a
 * node of kind definition; a rule that refers to another rule of the set gets a "refers to" edge. A rule replaced in a
 * new version retires its node.
 *
 * Only called from person-triggered code: decideRules (a person presses Approve). Never from the crawler or the
 * reading passes, which read outside content (the test in src/lib/changes enforces it).
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { corpora, corpusRules, nodes, sources } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { abandonChangeSet, deliverChangeSet, proposeChanges, type ChangeInput } from "@/lib/changes";
import { clip } from "@/lib/compliance/text";

const BATCH = 60;

/** The node label of a rule ("§ 5, stk. 2: Klientkonto skal oprettes") or a definition (its term). */
export function ruleLabel(r: { kind: string; ref: string; title: string }): string {
  return clip(r.kind === "definition" ? r.title : `${r.ref}: ${r.title}`, 200);
}

/** Put approved rules (ids) into the graph. Returns how many nodes now stand for them. Best effort: never throws. */
export async function mirrorApproved(v: Viewer, corpusId: string, ruleIds: string[]): Promise<{ nodes: number; retired: number; changeSets: string[] }> {
  const out = { nodes: 0, retired: 0, changeSets: [] as string[] };
  try {
    const [c] = await db.select({ id: corpora.id, name: corpora.name, nodeId: corpora.nodeId }).from(corpora).where(and(eq(corpora.id, corpusId), eq(corpora.graphId, v.graphId))).limit(1);
    if (!c?.nodeId) return out;
    // The rules just decided, and any approved rule a failed earlier attempt left outside the graph.
    const rows = await db.select().from(corpusRules).where(and(eq(corpusRules.corpusId, corpusId),
      or(ruleIds.length ? inArray(corpusRules.id, ruleIds) : undefined, and(eq(corpusRules.status, "active"), isNull(corpusRules.nodeId)))));
    const urls = new Map((await db.select({ id: sources.id, url: sources.url }).from(sources).where(inArray(sources.id, rows.map((r) => r.sourceId).filter((x): x is string => !!x)))).map((s) => [s.id, s.url]));
    // Rules already in the graph, for "refers to" edges to them.
    const placed = await db.select({ unitKey: corpusRules.unitKey, nodeId: corpusRules.nodeId }).from(corpusRules)
      .where(and(eq(corpusRules.corpusId, corpusId), eq(corpusRules.status, "active"), isNotNull(corpusRules.nodeId)));
    const nodeOfUnit = new Map<string, string>();
    for (const p of placed) if (p.unitKey && p.nodeId) nodeOfUnit.set(p.unitKey, p.nodeId);

    // Retire the nodes of rules a new version replaced or removed.
    const retireIds = new Set<string>();
    for (const r of rows.filter((x) => (x.change === "changed" || x.change === "removed") && x.supersedesId)) {
      const [old] = await db.select({ nodeId: corpusRules.nodeId }).from(corpusRules).where(eq(corpusRules.id, r.supersedesId!)).limit(1);
      if (old?.nodeId) retireIds.add(old.nodeId);
    }
    const adding = rows.filter((r) => r.change !== "removed" && r.status === "active" && !r.nodeId);
    const minted = new Map(adding.map((r) => [r.id, randomUUID()]));
    for (const r of adding) if (r.unitKey) nodeOfUnit.set(r.unitKey, minted.get(r.id)!);

    // "Refers to" edges go in last, once every rule they connect is a node.
    const refEdges: { from: string; toMinted: string; note: string; receipt: ChangeInput["receipt"] }[] = [];
    const deliver = async (ops: ChangeInput[], sourceId?: string | null) => {
      const set = await proposeChanges(v, {
        title: `Rules of ${c.name}`.slice(0, 200), origin: "ingest",
        description: `Approved on the rule set's page by ${v.name}. Each rule cites the exact words it comes from.`,
        evidence: { sourceId: sourceId ?? undefined }, changes: ops,
      });
      if (!set) return false;
      const res = await deliverChangeSet(v, set.id);
      if (!res.ok) {
        console.warn("[rules] the graph change set wasn't delivered:", res.error ?? res.conflicts?.join("; "));
        // Nothing half-done is left waiting: the rules stay approved, and the next approval tries again.
        await abandonChangeSet(v, set.id).catch(() => {});
        return false;
      }
      out.changeSets.push(set.id);
      return true;
    };
    for (let i = 0; i < Math.max(adding.length, retireIds.size ? 1 : 0); i += BATCH) {
      const batch = adding.slice(i, i + BATCH);
      const ops: ChangeInput[] = [];
      for (const r of batch) {
        const id = minted.get(r.id)!;
        const receipt = { sourceId: r.sourceId ?? undefined, chunkId: r.chunkId ?? undefined, locator: (r.locator ?? {}) as Record<string, unknown>, quote: r.quote ?? undefined, url: r.sourceId ? urls.get(r.sourceId) ?? undefined : undefined, confidence: r.confidence ?? undefined };
        const def = r.kind === "definition";
        ops.push({
          op: "addNode", nodeId: id, type: "document", kind: def ? "definition" : "rule", label: ruleLabel(r), summary: r.text,
          props: def ? { term: r.title, ref: r.ref } : { ref: r.ref, says: r.modality, ...(r.quote ? { quote: clip(r.quote, 1500) } : {}) }, visibility: "household",
          note: def ? `Definition in ${c.name}` : `${r.ref} in ${c.name}`, receipt,
        });
        ops.push({ op: "addEdge", fromId: id, toId: c.nodeId, relation: "rule_in", status: "confirmed", confidence: 1, note: `Part of ${c.name}`, receipt });
        for (const ref of ((r.refs ?? []) as { unitKey?: string; external?: boolean }[])) {
          if (ref.external || !ref.unitKey) continue;
          const to = nodeOfUnit.get(ref.unitKey) ?? [...nodeOfUnit.entries()].find(([k]) => k.startsWith(`${ref.unitKey}, `) || k.startsWith(`${ref.unitKey}(`))?.[1];
          if (to && to !== id) refEdges.push({ from: r.id, toMinted: to, note: `${r.ref} refers to ${ref.unitKey}`, receipt });
        }
      }
      if (i === 0) for (const nid of retireIds) ops.push({ op: "retireNode", nodeId: nid, note: "Replaced or removed in a new version of the text" });
      if (!ops.length) continue;
      if (!(await deliver(ops, batch[0]?.sourceId))) continue;
      if (i === 0) out.retired = retireIds.size;
      // Which nodes stand for the rules now: the minted one, or the node an identical one was matched to.
      for (const r of batch) {
        const id = minted.get(r.id)!;
        let nodeId: string | null = null;
        const [n] = await db.select({ id: nodes.id }).from(nodes).where(and(eq(nodes.id, id), eq(nodes.graphId, v.graphId))).limit(1);
        if (n) nodeId = n.id;
        else {
          const [m] = await db.select({ id: nodes.id }).from(nodes).where(and(eq(nodes.graphId, v.graphId), eq(nodes.label, ruleLabel(r)), eq(nodes.kind, r.kind === "definition" ? "definition" : "rule"), isNull(nodes.mergedInto))).limit(1);
          nodeId = m?.id ?? null;
        }
        if (nodeId) { await db.update(corpusRules).set({ nodeId }).where(eq(corpusRules.id, r.id)); out.nodes++; }
      }
    }
    if (refEdges.length) {
      const now = new Map((await db.select({ id: corpusRules.id, nodeId: corpusRules.nodeId }).from(corpusRules).where(and(eq(corpusRules.corpusId, corpusId), isNotNull(corpusRules.nodeId)))).map((r) => [r.id, r.nodeId!]));
      const mintedToRule = new Map<string, string>([...minted.entries()].map(([ruleId, m]) => [m as string, ruleId]));
      const live = new Set((await db.select({ id: nodes.id }).from(nodes).where(and(eq(nodes.graphId, v.graphId), inArray(nodes.id, [...new Set([...now.values(), ...refEdges.map((e) => e.toMinted)])])))).map((n) => n.id));
      const ops: ChangeInput[] = [];
      const seen = new Set<string>();
      for (const e of refEdges) {
        const from = now.get(e.from);
        const to = mintedToRule.has(e.toMinted) ? now.get(mintedToRule.get(e.toMinted)!) : e.toMinted;
        if (!from || !to || from === to || !live.has(from) || !live.has(to) || seen.has(`${from}>${to}`)) continue;
        seen.add(`${from}>${to}`);
        ops.push({ op: "addEdge", fromId: from, toId: to, relation: "refers_to", status: "confirmed", confidence: 0.9, note: e.note, receipt: e.receipt });
      }
      for (let i = 0; i < ops.length; i += 150) await deliver(ops.slice(i, i + 150));
    }
  } catch (e) {
    console.error("[rules] putting rules in the graph failed:", e instanceof Error ? e.message : e);
  }
  return out;
}
