/**
 * The graph's memory, pure (no DB, no Next): what a node or fact looked like, what moved between two looks, how rapid
 * edits by one hand fold into one line, and how to rewind the graph to an earlier moment. After Nexus lib/history
 * (record.ts, events.ts, asof.ts, diff.ts): history is observed, not declared — a write is snapshotted before and after
 * and the difference is what gets written down.
 */

/** Rapid edits by the same hand to the same field within this window are one line in the history. */
export const MOMENT_MS = 120_000;

export type NodeSnap = {
  id: string; graphId: string; ownerId: string; householdId: string; type: string; kind: string | null; label: string; aliases: string[];
  summary: string | null; props: Record<string, unknown>; startAt: string | null; endAt: string | null; timePrecision: string | null;
  visibility: "private" | "parents" | "household"; sensitive: boolean; mergedInto: string | null;
};

export type EdgeSnap = {
  id: string; graphId: string; ownerId: string; householdId: string; fromId: string; toId: string; relation: string; status: string;
  confidence: number; visibility: "private" | "parents" | "household"; validFrom: string | null; validTo: string | null;
};

export type MetaSnap = { id: string; table: "kinds" | "relations" | "attributes" | "roles"; key: string; label: string; [field: string]: unknown };

/** Fields of a node the history follows (props are followed key by key as `props.<key>`). */
export const NODE_FIELDS = ["type", "kind", "label", "aliases", "summary", "startAt", "endAt", "timePrecision", "visibility", "sensitive", "mergedInto"] as const;
export const EDGE_FIELDS = ["fromId", "toId", "relation", "status", "confidence", "visibility", "validFrom", "validTo"] as const;
/** Bookkeeping props that are not facts about the thing (merge dismissals). */
export const INTERNAL_PROPS = new Set(["gbrainNotSame"]);

export type EventDraft = {
  subjectType: "node" | "edge" | "meta" | "wiki";
  subjectId: string;
  subjectName: string | null;
  kind: "created" | "updated" | "removed" | "merged" | "retired" | "restored";
  field: string | null;
  fromValue: unknown;
  toValue: unknown;
  fromNodeId?: string | null;
  toNodeId?: string | null;
};

const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

/** A node row (any shape with the node columns) as a snapshot. */
export function nodeSnap(r: {
  id: string; graphId: string; ownerId: string; householdId: string; type: string; kind?: string | null; label: string; aliases?: string[] | null;
  summary?: string | null; props?: Record<string, unknown> | null; startAt?: Date | string | null; endAt?: Date | string | null;
  timePrecision?: string | null; visibility: NodeSnap["visibility"]; sensitive?: boolean | null; mergedInto?: string | null;
}): NodeSnap {
  return {
    id: r.id, graphId: r.graphId, ownerId: r.ownerId, householdId: r.householdId, type: r.type, kind: r.kind ?? null, label: r.label,
    aliases: [...(r.aliases ?? [])], summary: r.summary ?? null, props: { ...(r.props ?? {}) }, startAt: iso(r.startAt), endAt: iso(r.endAt),
    timePrecision: r.timePrecision ?? null, visibility: r.visibility, sensitive: !!r.sensitive, mergedInto: r.mergedInto ?? null,
  };
}

export function edgeSnap(r: {
  id: string; graphId: string; ownerId: string; householdId: string; fromId: string; toId: string; relation: string; status: string;
  confidence: number; visibility: EdgeSnap["visibility"]; validFrom?: Date | string | null; validTo?: Date | string | null;
}): EdgeSnap {
  return {
    id: r.id, graphId: r.graphId, ownerId: r.ownerId, householdId: r.householdId, fromId: r.fromId, toId: r.toId, relation: r.relation,
    status: r.status, confidence: Math.round(r.confidence * 100) / 100, visibility: r.visibility, validFrom: iso(r.validFrom), validTo: iso(r.validTo),
  };
}

/** Structural equality for stored values (JSON-ish). */
export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return (a ?? null) === (b ?? null);
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  const ka = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** What moved on one node, one entry per field. */
export function diffNode(before: NodeSnap | null, after: NodeSnap | null): EventDraft[] {
  if (!before && !after) return [];
  const base = { subjectType: "node" as const, subjectId: (after ?? before)!.id, subjectName: (after ?? before)!.label };
  if (!before) return [{ ...base, kind: "created", field: null, fromValue: null, toValue: after }];
  if (!after) return [{ ...base, kind: "removed", field: null, fromValue: before, toValue: null }];
  const out: EventDraft[] = [];
  for (const f of NODE_FIELDS) {
    if (!same(before[f], after[f])) {
      out.push({ ...base, kind: f === "mergedInto" && after.mergedInto ? "merged" : "updated", field: f, fromValue: before[f] ?? null, toValue: after[f] ?? null });
    }
  }
  const keys = new Set([...Object.keys(before.props), ...Object.keys(after.props)]);
  for (const k of [...keys].sort()) {
    if (INTERNAL_PROPS.has(k)) continue;
    if (!same(before.props[k], after.props[k])) out.push({ ...base, kind: "updated", field: `props.${k}`, fromValue: before.props[k] ?? null, toValue: after.props[k] ?? null });
  }
  return out;
}

/** What moved on one fact. Both ends are carried on every event so a fact can be rewound and named. */
export function diffEdge(before: EdgeSnap | null, after: EdgeSnap | null, name?: string | null): EventDraft[] {
  if (!before && !after) return [];
  const e = (after ?? before)!;
  const base = { subjectType: "edge" as const, subjectId: e.id, subjectName: name ?? e.relation, fromNodeId: e.fromId, toNodeId: e.toId };
  if (!before) return [{ ...base, kind: "created", field: null, fromValue: null, toValue: after }];
  if (!after) return [{ ...base, kind: "removed", field: null, fromValue: before, toValue: null }];
  const out: EventDraft[] = [];
  for (const f of EDGE_FIELDS) {
    if (!same(before[f], after[f])) out.push({ ...base, kind: "updated", field: f, fromValue: before[f] ?? null, toValue: after[f] ?? null });
  }
  return out;
}

/** What moved in the meta model (kinds, relation types, attributes), by row id. */
export function diffMeta(before: Map<string, MetaSnap>, after: Map<string, MetaSnap>): EventDraft[] {
  const out: EventDraft[] = [];
  const ids = new Set([...before.keys(), ...after.keys()]);
  for (const id of ids) {
    const b = before.get(id) ?? null, a = after.get(id) ?? null;
    const name = (a ?? b)!.label;
    const base = { subjectType: "meta" as const, subjectId: id, subjectName: name };
    if (!b) { out.push({ ...base, kind: "created", field: null, fromValue: null, toValue: a }); continue; }
    if (!a) { out.push({ ...base, kind: "removed", field: null, fromValue: b, toValue: null }); continue; }
    const fields = new Set([...Object.keys(b), ...Object.keys(a)]);
    for (const f of [...fields].sort()) {
      if (f === "id" || f === "evidenceCount") continue;
      if (!same(b[f], a[f])) out.push({ ...base, kind: "updated", field: f, fromValue: b[f] ?? null, toValue: a[f] ?? null });
    }
  }
  return out;
}

export type Coalesced = { action: "insert" } | { action: "drop" } | { action: "extend"; from: unknown; to: unknown };

/**
 * Fold an edit into the one before it when it continues it: the same field updated again (prev.to is next.from).
 * Back where it started → the line disappears. The caller has already checked it is the same hand within MOMENT_MS.
 */
export function coalesce(prev: { kind: string; field: string | null; fromValue: unknown; toValue: unknown } | null, next: EventDraft): Coalesced {
  if (!prev) return { action: "insert" };
  if (prev.kind !== "updated" || next.kind !== "updated") return { action: "insert" };
  if (!prev.field || prev.field !== next.field) return { action: "insert" };
  if (!same(prev.toValue, next.fromValue)) return { action: "insert" };
  if (same(prev.fromValue, next.toValue)) return { action: "drop" };
  return { action: "extend", from: prev.fromValue, to: next.toValue };
}

/** Same hand: who, through which proposal, where, and close enough in time. */
export function sameHand(
  prev: { actorKind: string; actorId: string | null; changeSetId: string | null; context: string | null; at: Date | string },
  next: { actorKind: string; actorId: string | null; changeSetId: string | null; context: string | null; at: Date | string },
  windowMs = MOMENT_MS,
): boolean {
  if (prev.actorKind !== next.actorKind || (prev.actorId ?? null) !== (next.actorId ?? null)) return false;
  if ((prev.changeSetId ?? null) !== (next.changeSetId ?? null) || (prev.context ?? null) !== (next.context ?? null)) return false;
  const gap = Math.abs(new Date(next.at).getTime() - new Date(prev.at).getTime());
  return gap <= windowMs;
}

/* ── Rewinding ───────────────────────────────────────────────────────────────────────────────────────── */

export type StoredEvent = {
  id: string; subjectType: string; subjectId: string; kind: string; field: string | null; fromValue: unknown; toValue: unknown;
  fromNodeId?: string | null; toNodeId?: string | null; at: Date | string;
};

export type GraphState = { nodes: Map<string, NodeSnap>; edges: Map<string, EdgeSnap> };

function clone<T>(x: T): T {
  return x === null || x === undefined ? x : (JSON.parse(JSON.stringify(x)) as T);
}

/**
 * The graph as it was at `at`: start from now and undo every event newer than `at`, newest first (Nexus asof.ts).
 * A thing created after `at` disappears, a removed one comes back, every field goes back to what it was. History
 * only reaches back to the first recorded event; before that the earliest known state is what you get.
 */
export function rewind(now: GraphState, events: StoredEvent[], at: Date): GraphState {
  const nodes = new Map([...now.nodes].map(([k, v]) => [k, clone(v)]));
  const edges = new Map([...now.edges].map(([k, v]) => [k, clone(v)]));
  const t = at.getTime();
  const newestFirst = [...events].filter((e) => new Date(e.at).getTime() > t)
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime() || (b.id < a.id ? -1 : b.id > a.id ? 1 : 0));
  for (const e of newestFirst) {
    const map = e.subjectType === "node" ? nodes : e.subjectType === "edge" ? edges : null;
    if (!map) continue;
    if (e.kind === "created") { map.delete(e.subjectId); continue; }
    if (e.kind === "removed") {
      if (e.fromValue && typeof e.fromValue === "object") map.set(e.subjectId, clone(e.fromValue) as never);
      continue;
    }
    const cur = map.get(e.subjectId) as Record<string, unknown> | undefined;
    if (!cur || !e.field) continue;
    if (e.field.startsWith("props.")) {
      const key = e.field.slice(6);
      const props = { ...((cur.props as Record<string, unknown>) ?? {}) };
      if (e.fromValue === null || e.fromValue === undefined) delete props[key]; else props[key] = clone(e.fromValue);
      cur.props = props;
    } else {
      cur[e.field] = clone(e.fromValue ?? null);
    }
  }
  return { nodes, edges };
}

export type StateDiff = {
  nodesAdded: NodeSnap[]; nodesRemoved: NodeSnap[];
  nodesChanged: { before: NodeSnap; after: NodeSnap; fields: { field: string; from: unknown; to: unknown }[] }[];
  edgesAdded: EdgeSnap[]; edgesRemoved: EdgeSnap[];
  edgesChanged: { before: EdgeSnap; after: EdgeSnap; fields: { field: string; from: unknown; to: unknown }[] }[];
};

const ACTIVE_EDGE = (e: EdgeSnap) => e.status !== "rejected" && e.status !== "superseded";
const LIVE_NODE = (n: NodeSnap) => !n.mergedInto && n.props.retired !== true;

/** What changed between two looks at the graph, by id (no merge base needed). Inactive facts count as gone. */
export function diffStates(a: GraphState, b: GraphState): StateDiff {
  const out: StateDiff = { nodesAdded: [], nodesRemoved: [], nodesChanged: [], edgesAdded: [], edgesRemoved: [], edgesChanged: [] };
  const liveA = new Map([...a.nodes].filter(([, n]) => LIVE_NODE(n))), liveB = new Map([...b.nodes].filter(([, n]) => LIVE_NODE(n)));
  for (const [id, n] of liveB) {
    const was = liveA.get(id);
    if (!was) { out.nodesAdded.push(n); continue; }
    const fields = diffNode(was, n).map((d) => ({ field: d.field ?? "", from: d.fromValue, to: d.toValue }));
    if (fields.length) out.nodesChanged.push({ before: was, after: n, fields });
  }
  for (const [id, n] of liveA) if (!liveB.has(id)) out.nodesRemoved.push(n);
  const actA = new Map([...a.edges].filter(([, e]) => ACTIVE_EDGE(e))), actB = new Map([...b.edges].filter(([, e]) => ACTIVE_EDGE(e)));
  for (const [id, e] of actB) {
    const was = actA.get(id);
    if (!was) { out.edgesAdded.push(e); continue; }
    const fields = diffEdge(was, e).map((d) => ({ field: d.field ?? "", from: d.fromValue, to: d.toValue }));
    if (fields.length) out.edgesChanged.push({ before: was, after: e, fields });
  }
  for (const [id, e] of actA) if (!actB.has(id)) out.edgesRemoved.push(e);
  return out;
}

export const isLiveNode = LIVE_NODE;
export const isActiveEdge = ACTIVE_EDGE;
