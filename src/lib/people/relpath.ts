/**
 * "Relation to you": the shortest path (≤ 2 hops) between a centre person and everyone else over person–person edges,
 * labelled with meta-model relation labels — "Your child", "Emma's teacher", "Works with you".
 */
import { findKind, findRelation } from "@/lib/meta/model";
import type { MetaModel } from "@/lib/meta/types";

export type PathEdge = { id: string; fromId: string; toId: string; relation: string; status?: string };
export type PathNode = { id: string; label: string; type: string; kind: string | null };

export type RelationToCenter = {
  label: string;
  hops: 1 | 2;
  /** The middle person on a 2-hop path. */
  via: { id: string; label: string } | null;
  /** Relation key of the edge touching this person, and its meta category. */
  relation: string;
  category: string;
};

const CATEGORY_RANK: Record<string, number> = { family: 0, care: 1, school: 2, social: 3, work: 4 };
const BAD_STATUS = new Set(["rejected", "superseded"]);
/** Relation categories that say nothing about how people relate (a person "mentions" someone, etc.). */
const NON_SOCIAL = new Set(["document", "time", "place"]);

export function possessive(name: string): string {
  const n = name.trim();
  return /s$/i.test(n) ? `${n}'` : `${n}'s`;
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** How `x` relates to the other end of `e`, as noun ("teacher") or verb phrase ("works with"). */
export function roleOf(m: MetaModel, e: PathEdge, x: PathNode): { noun: string | null; verb: string } {
  const r = findRelation(m, e.relation);
  const out = e.fromId === x.id;
  const raw = r ? (out || r.symmetric ? r.label : r.inverseLabel) : e.relation.replace(/_/g, " ");
  const label = raw.trim().toLowerCase();
  if (label.endsWith(" of")) return { noun: label.slice(0, -3), verb: label };
  const k = findKind(m, x.type, x.kind);
  return { noun: k && k.key !== "other" ? k.label.toLowerCase() : null, verb: label };
}

/** Phrase for `x` relative to `anchor` ("you" when the anchor is the viewer). */
export function phrase(role: { noun: string | null; verb: string }, anchor: { label: string; isYou: boolean }): string {
  if (role.noun) return anchor.isYou ? `Your ${role.noun}` : `${possessive(anchor.label)} ${role.noun}`;
  return cap(`${role.verb} ${anchor.isYou ? "you" : anchor.label}`);
}

function edgeScore(m: MetaModel, e: PathEdge): number {
  const cat = findRelation(m, e.relation)?.category ?? "other";
  return (CATEGORY_RANK[cat] ?? 5) + (e.status === "confirmed" ? 0 : 0.5);
}

/**
 * For every person reachable from `centerId` within two hops over person–person edges, the best labelled path.
 * Ties are broken by relation category (family first) and confirmed edges.
 */
export function relationsToCenter(m: MetaModel, centerId: string, nodes: Map<string, PathNode>, edges: PathEdge[],
  opts: { centerIsViewer: boolean }): Map<string, RelationToCenter> {
  const center = nodes.get(centerId);
  const out = new Map<string, RelationToCenter>();
  if (!center) return out;
  const adj = new Map<string, PathEdge[]>();
  for (const e of edges) {
    if (e.status && BAD_STATUS.has(e.status)) continue;
    if (NON_SOCIAL.has(findRelation(m, e.relation)?.category ?? "")) continue;
    const a = nodes.get(e.fromId), b = nodes.get(e.toId);
    if (!a || !b || a.type !== "person" || b.type !== "person" || a.id === b.id) continue;
    (adj.get(a.id) ?? adj.set(a.id, []).get(a.id)!).push(e);
    (adj.get(b.id) ?? adj.set(b.id, []).get(b.id)!).push(e);
  }
  const other = (e: PathEdge, id: string) => (e.fromId === id ? e.toId : e.fromId);
  const anchorC = { label: center.label, isYou: opts.centerIsViewer };

  // 1 hop
  const first = new Map<string, { e: PathEdge; score: number }>();
  for (const e of adj.get(centerId) ?? []) {
    const xId = other(e, centerId);
    const s = edgeScore(m, e);
    const cur = first.get(xId);
    if (!cur || s < cur.score) first.set(xId, { e, score: s });
  }
  for (const [xId, { e }] of first) {
    const x = nodes.get(xId)!;
    out.set(xId, { label: phrase(roleOf(m, e, x), anchorC), hops: 1, via: null, relation: e.relation, category: findRelation(m, e.relation)?.category ?? "other" });
  }

  // 2 hops: centre — M — X
  const second = new Map<string, { e: PathEdge; mid: PathNode; score: number }>();
  for (const [midId, { score: s1 }] of first) {
    const mid = nodes.get(midId)!;
    for (const e of adj.get(midId) ?? []) {
      const xId = other(e, midId);
      if (xId === centerId || first.has(xId)) continue;
      const s = s1 + edgeScore(m, e);
      const cur = second.get(xId);
      if (!cur || s < cur.score) second.set(xId, { e, mid, score: s });
    }
  }
  for (const [xId, { e, mid }] of second) {
    const x = nodes.get(xId)!;
    out.set(xId, {
      label: phrase(roleOf(m, e, x), { label: mid.label, isYou: false }), hops: 2, via: { id: mid.id, label: mid.label },
      relation: e.relation, category: findRelation(m, e.relation)?.category ?? "other",
    });
  }
  return out;
}
