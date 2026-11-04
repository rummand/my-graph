/**
 * Rebasing a proposal onto the graph as it is now (pure, no DB). Each op gets a verdict, a reason code and the details
 * a person needs to decide:
 *
 *  - outstanding  still to do.
 *  - exists       an "Add" whose thing is already in the graph: the same type, the same name (or a matching alias),
 *                 a compatible kind, exactly one match, not retired. Deliverable: the add is skipped, the existing
 *                 node is used wherever the set referred to the new one, and the evidence is recorded on it.
 *  - landed       the graph already says it (a fact that is already there still gets this document's evidence).
 *  - conflicted   a person has to decide; never delivered as is. Codes: target_retired, target_merged,
 *                 target_missing, value_changed, ambiguous_existing, kind_mismatch, depends_on_left_out,
 *                 no_permission, different_types.
 *
 * A person's decision on one op (use this one, add as new, follow the merge, keep the graph's value) is stored on the
 * op as `payload.resolution`, so it is part of the fingerprint like a tick is.
 */
import type { EdgeSnap, NodeSnap } from "@/lib/history/pure";

/** A stored change as the pure functions see it. */
export type ChangeRowLike = { id: string; seq: number; op: string; nodeId: string | null; edgeId: string | null; payload: Record<string, unknown>; included: boolean };

export const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

export type Verdict = "outstanding" | "landed" | "exists" | "conflicted";

export const PROBLEM_CODES = [
  "ambiguous_existing", "kind_mismatch", "target_merged", "value_changed", "depends_on_left_out", "target_retired", "target_missing", "no_permission", "different_types",
] as const;
export type ProblemCode = (typeof PROBLEM_CODES)[number];
export type ReasonCode = ProblemCode | "exists" | "already_true" | "kept_graph"
  | "to_add" | "to_change" | "to_retire" | "to_merge" | "to_connect" | "to_remove" | "to_remind" | "model" | "other";

/** What a person decided for one op. */
export type Resolution = {
  /** Use this existing node instead of adding a new one (ambiguous_existing, kind_mismatch). */
  use?: string;
  /** Add it as a new node even though something with the same name exists. */
  asNew?: boolean;
  /** Point the op at the node its target was merged into (target_merged). */
  follow?: boolean;
  /** value_changed: write the proposal's value, or keep what the graph says now. */
  keep?: "proposal" | "graph";
};

/** Where an existing node came from, as history tells it (for "added from 'X' earlier today"). */
export type Origin = { changeSetId: string | null; changeSetTitle: string | null; sourceId: string | null; sourceTitle: string | null; at: string | null; by: string | null };
export type NodeRef = { id: string; label: string; type: string; kind: string | null };

export type ReasonDetails = {
  /** exists: the node that will be used. */
  existing?: NodeRef & { via: "label" | "alias" | "chosen"; origin?: Origin | null };
  /** ambiguous_existing / kind_mismatch: the nodes with that name. */
  candidates?: (NodeRef & { origin?: Origin | null })[];
  /** What the op points at (retired, merged, missing, not visible). */
  target?: { id: string; label: string | null };
  mergedInto?: NodeRef;
  /** When and by whom the target was retired, merged or changed. */
  at?: string | null;
  by?: string | null;
  /** value_changed: each field, what the graph says now and what the proposal says. */
  fields?: { field: string; now: unknown; proposed: unknown }[];
  /** depends_on_left_out: the unticked op that adds what this needs. */
  dependsOn?: { changeId: string; label: string };
  /** landed fact: the existing fact this document also supports. */
  edgeId?: string;
  /** Ids this op will point at instead (a new node → the existing one; a merged node → the one it was merged into). */
  remap?: Record<string, string>;
  resolution?: Resolution;
};

export type OpVerdict = { verdict: Verdict; code: ReasonCode; details?: ReasonDetails };

/* ── The graph now, as verdicts need it ──────────────────────────────────────────────────────────────── */

/** A node that an "Add" might mean: same type, any name. */
export type NodeCand = { id: string; type: string; kind: string | null; label: string; aliases: string[]; retired?: boolean; mergedInto?: string | null };
export type NodeEvent = { kind: string; field: string | null; at: string; by: string | null; changeSetId: string | null };

export type Now = {
  /** Nodes the person delivering can see (merged and retired ones included, flagged). */
  nodes: Map<string, Pick<NodeSnap, "id" | "type" | "label" | "aliases" | "summary" | "kind" | "props" | "startAt" | "endAt" | "visibility" | "sensitive" | "mergedInto">>;
  edges: Map<string, Pick<EdgeSnap, "id" | "fromId" | "toId" | "relation" | "status" | "confidence" | "validFrom" | "validTo" | "visibility">>;
  /** Active facts, as `from|relation|to`, with the id of the fact. */
  triples: Map<string, string>;
  /** Readable nodes of the types the set adds (the graph index matchExisting searches). */
  index: NodeCand[];
  /** Ids that exist in this graph but the viewer may not see. */
  hidden: Set<string>;
  /** Readable nodes the viewer may not change. */
  readOnly: Set<string>;
  /** History of the nodes ops point at, newest first. */
  events: Map<string, NodeEvent[]>;
  /** Where existing nodes came from (exists matches). */
  origins: Map<string, Origin>;
  /** Model elements this graph sees: `kinds:type:key`, `relations:key`, `attributes:type:kind:key`. */
  meta: Set<string>;
};

export function emptyNow(): Now {
  return { nodes: new Map(), edges: new Map(), triples: new Map(), index: [], hidden: new Set(), readOnly: new Set(), events: new Map(), origins: new Map(), meta: new Set() };
}

const INACTIVE = new Set(["rejected", "superseded"]);
const p = <T = unknown>(c: ChangeRowLike, k: string) => c.payload[k] as T;
const isRetired = (props: Record<string, unknown> | null | undefined) => props?.retired === true || props?.retired === "true";

function valueEq(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) return new Date(a as never).getTime() === new Date(b as never).getTime();
  if ((a ?? null) === (b ?? null)) return true;
  if (typeof a === "string" && typeof b === "string" && /^\d{4}-\d\d-\d\d/.test(a) && /^\d{4}-\d\d-\d\d/.test(b)) return new Date(a).getTime() === new Date(b).getTime();
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Does a node already say everything `set` would make it say? */
export function alreadySays(node: Record<string, unknown>, set: Record<string, unknown>): boolean {
  return Object.entries(set).every(([k, v]) => {
    if (k === "props" && v && typeof v === "object") {
      const props = (node.props ?? {}) as Record<string, unknown>;
      return Object.entries(v as Record<string, unknown>).every(([pk, pv]) => valueEq(props[pk], pv));
    }
    if (k === "label" && typeof v === "string" && typeof node.label === "string") return norm(v) === norm(node.label);
    return valueEq(node[k], v);
  });
}

export function resolutionOf(c: Pick<ChangeRowLike, "payload">): Resolution {
  const r = c.payload?.resolution;
  if (!r || typeof r !== "object" || Array.isArray(r)) return {};
  const o = r as Record<string, unknown>;
  const out: Resolution = {};
  if (typeof o.use === "string" && o.use) out.use = o.use;
  if (o.asNew === true) out.asNew = true;
  if (o.follow === true) out.follow = true;
  if (o.keep === "proposal" || o.keep === "graph") out.keep = o.keep;
  return out;
}

/* ── Is this "Add" something the graph already has? ──────────────────────────────────────────────────── */

export type Match =
  | { kind: "none" }
  | { kind: "exists"; node: NodeCand; via: "label" | "alias" }
  | { kind: "ambiguous"; candidates: NodeCand[] }
  | { kind: "kind_mismatch"; candidates: NodeCand[] };

/**
 * Find the node an addNode op means, among the live nodes of the graph (`graphIndex`). Same type; the same name
 * (case and spacing don't matter) or one of its aliases; never a retired or merged node. A kind on both sides must
 * agree (a missing kind on either side is not a disagreement). Only one match is safe: several are ambiguous, and
 * the same name as another kind is a kind mismatch. A match on the label beats a match on an alias.
 */
export function matchExisting(op: { type?: unknown; label?: unknown; kind?: unknown; aliases?: unknown }, graphIndex: NodeCand[]): Match {
  const type = typeof op.type === "string" ? op.type : "thing";
  const label = typeof op.label === "string" ? norm(op.label) : "";
  if (!label) return { kind: "none" };
  const kind = typeof op.kind === "string" && op.kind ? op.kind : null;
  const wanted = new Set([label, ...(Array.isArray(op.aliases) ? op.aliases.filter((a): a is string => typeof a === "string").map(norm).filter(Boolean) : [])]);
  const live = graphIndex.filter((n) => n.type === type && !n.retired && !n.mergedInto);
  const byLabel = live.filter((n) => wanted.has(norm(n.label)));
  const byAlias = live.filter((n) => !byLabel.includes(n) && (n.aliases ?? []).some((a) => wanted.has(norm(a))));
  const fits = (n: NodeCand) => !kind || !n.kind || n.kind === kind;
  for (const [tier, via] of [[byLabel, "label"], [byAlias, "alias"]] as const) {
    const ok = tier.filter(fits);
    if (ok.length === 1) return { kind: "exists", node: ok[0], via };
    if (ok.length > 1) return { kind: "ambiguous", candidates: ok };
  }
  const other = [...byLabel, ...byAlias];
  return other.length ? { kind: "kind_mismatch", candidates: other } : { kind: "none" };
}

/* ── Pointing a set's ops at other nodes ─────────────────────────────────────────────────────────────── */

const NODE_REFS = ["fromId", "toId", "keepId", "dropId", "aboutNodeId"] as const;

/**
 * Every op that refers to a node in `mapping` (minted id → existing id, or merged → kept) now refers to the other one:
 * a fact's ends, the node an update or retire is about, a merge's two sides, a reminder's subject. An "Add" keeps its
 * own id (it is skipped, not rewritten). Returns new rows; the input is untouched.
 */
export function remapMinted<T extends ChangeRowLike>(ops: T[], mapping: Record<string, string> | Map<string, string>): T[] {
  const m = mapping instanceof Map ? mapping : new Map(Object.entries(mapping));
  if (!m.size) return ops;
  const swap = <X>(x: X): X => (typeof x === "string" && m.has(x) ? (m.get(x) as X) : x);
  return ops.map((c) => {
    const payload = { ...c.payload };
    for (const k of NODE_REFS) if (k in payload) payload[k] = swap(payload[k]);
    return { ...c, nodeId: c.op === "addNode" ? c.nodeId : swap(c.nodeId), payload };
  });
}

/* ── Verdicts ────────────────────────────────────────────────────────────────────────────────────────── */

type Pointed = { ok: true; id: string } | { ok: false; v: OpVerdict };

/**
 * Replay each op onto the graph now. `includedOnly`: only ticked "Add"s count for facts that need them (delivery, and
 * the review, where an unticked add makes its facts depend on something left out). `setId` and `baseAt` let an update
 * notice that someone else changed the same field after the proposal was made.
 */
export function verdictsFor(changes: ChangeRowLike[], now: Now, opts: { includedOnly?: boolean; setId?: string | null; baseAt?: Date | string | null } = {}): Record<string, OpVerdict> {
  const out: Record<string, OpVerdict> = {};
  const sorted = [...changes].sort((a, b) => a.seq - b.seq);
  const minted = new Map<string, ChangeRowLike>();
  for (const c of sorted) if (c.op === "addNode" && c.nodeId) minted.set(c.nodeId, c);
  const baseAt = opts.baseAt ? new Date(opts.baseAt).getTime() : null;

  const ref = (id: string): NodeRef | null => {
    const n = now.nodes.get(id) ?? now.index.find((x) => x.id === id);
    return n ? { id: n.id, label: n.label, type: n.type, kind: n.kind ?? null } : null;
  };
  const lastEvent = (id: string, test: (e: NodeEvent) => boolean) => (now.events.get(id) ?? []).find(test) ?? null;
  const originOf = (id: string) => now.origins.get(id) ?? null;
  const usable = (id: string) => {
    const n = now.nodes.get(id) ?? now.index.find((x) => x.id === id);
    return !!n && !n.mergedInto && !isRetired((n as { props?: Record<string, unknown> }).props) && !(n as NodeCand).retired;
  };

  // Pass 1: the adds, so the ops after them know which new nodes are really existing ones.
  const mapping = new Map<string, string>();
  for (const c of sorted) {
    if (c.op !== "addNode") continue;
    const res = resolutionOf(c);
    const withRes = (v: OpVerdict): OpVerdict => (Object.keys(res).length ? { ...v, details: { ...v.details, resolution: res } } : v);
    if (c.nodeId && now.nodes.has(c.nodeId)) { out[c.id] = { verdict: "landed", code: "already_true" }; continue; }
    if (res.asNew) { out[c.id] = withRes({ verdict: "outstanding", code: "to_add" }); continue; }
    if (res.use) {
      const r = ref(res.use);
      out[c.id] = r && usable(res.use)
        ? withRes({ verdict: "exists", code: "exists", details: { existing: { ...r, via: "chosen", origin: originOf(r.id) } } })
        : withRes({ verdict: "conflicted", code: "target_missing", details: { target: { id: res.use, label: r?.label ?? null } } });
    } else {
      const m = matchExisting(c.payload, now.index);
      const cands = (xs: NodeCand[]) => xs.map((n) => ({ id: n.id, label: n.label, type: n.type, kind: n.kind, origin: originOf(n.id) }));
      if (m.kind === "exists") out[c.id] = { verdict: "exists", code: "exists", details: { existing: { id: m.node.id, label: m.node.label, type: m.node.type, kind: m.node.kind, via: m.via, origin: originOf(m.node.id) } } };
      else if (m.kind === "ambiguous") out[c.id] = { verdict: "conflicted", code: "ambiguous_existing", details: { candidates: cands(m.candidates) } };
      else if (m.kind === "kind_mismatch") out[c.id] = { verdict: "conflicted", code: "kind_mismatch", details: { candidates: cands(m.candidates) } };
      else out[c.id] = { verdict: "outstanding", code: "to_add" };
    }
    const v = out[c.id];
    if (v.verdict === "exists" && c.nodeId && v.details?.existing) mapping.set(c.nodeId, v.details.existing.id);
  }

  // Pass 2: everything else, pointed through that mapping.
  for (const c of sorted) {
    if (c.op === "addNode") continue;
    const res = resolutionOf(c);
    const remap: Record<string, string> = {};
    const bad = (code: ProblemCode, details: ReasonDetails = {}): Pointed => ({ ok: false, v: { verdict: "conflicted", code, details } });
    const point = (id: string | null | undefined, opt: { retiredOk?: boolean } = {}): Pointed => {
      if (!id) return bad("target_missing", { target: { id: "", label: null } });
      if (mapping.has(id)) { remap[id] = mapping.get(id)!; return { ok: true, id: mapping.get(id)! }; }
      const m = minted.get(id);
      if (m && !now.nodes.has(id)) {
        if (opts.includedOnly && !m.included) return bad("depends_on_left_out", { dependsOn: { changeId: m.id, label: String(m.payload.label ?? "") } });
        return { ok: true, id };
      }
      const n = now.nodes.get(id);
      if (n) {
        if (n.mergedInto) {
          let into = now.nodes.get(n.mergedInto);
          for (let hop = 0; into?.mergedInto && hop < 5; hop++) into = now.nodes.get(into.mergedInto);
          const ev = lastEvent(id, (e) => e.kind === "merged" || e.field === "mergedInto");
          if (res.follow && into && !into.mergedInto && !isRetired(into.props)) { remap[id] = into.id; return { ok: true, id: into.id }; }
          return bad("target_merged", { target: { id, label: n.label }, mergedInto: into ? { id: into.id, label: into.label, type: into.type, kind: into.kind ?? null } : undefined, at: ev?.at ?? null, by: ev?.by ?? null });
        }
        if (isRetired(n.props) && !opt.retiredOk) {
          const ev = lastEvent(id, (e) => e.kind === "retired" || e.field === "props.retired");
          return bad("target_retired", { target: { id, label: n.label }, at: (typeof n.props?.retiredAt === "string" ? n.props.retiredAt : null) ?? ev?.at ?? null, by: ev?.by ?? null });
        }
        return { ok: true, id };
      }
      if (now.hidden.has(id)) return bad("no_permission", { target: { id, label: null } });
      const gone = lastEvent(id, (e) => e.kind === "removed");
      return bad("target_missing", { target: { id, label: null }, at: gone?.at ?? null, by: gone?.by ?? null });
    };
    const done = (v: OpVerdict) => {
      const details = { ...(v.details ?? {}), ...(Object.keys(remap).length ? { remap: { ...remap } } : {}), ...(Object.keys(res).length ? { resolution: res } : {}) };
      out[c.id] = Object.keys(details).length ? { ...v, details } : { verdict: v.verdict, code: v.code };
    };
    const writable = (id: string) => (now.readOnly.has(id) ? bad("no_permission", { target: { id, label: now.nodes.get(id)?.label ?? null } }) : null);

    switch (c.op) {
      case "updateNode": {
        // Bringing a retired thing back is an update that clears the marker: that one may touch a retired node.
        const restores = (p<Record<string, unknown>>(c, "set")?.props as Record<string, unknown> | undefined)?.retired;
        const t = point(c.nodeId, { retiredOk: restores === null || restores === false });
        if (!t.ok) { done(t.v); break; }
        const ro = writable(t.id); if (ro && !ro.ok) { done(ro.v); break; }
        const n = now.nodes.get(t.id);
        const set = p<Record<string, unknown>>(c, "set") ?? {};
        if (!n) { done({ verdict: "outstanding", code: "to_change" }); break; } // a node this set adds
        if (alreadySays(n as unknown as Record<string, unknown>, set)) { done({ verdict: "landed", code: "already_true" }); break; }
        if (res.keep === "graph") { done({ verdict: "landed", code: "kept_graph" }); break; }
        if (res.keep !== "proposal" && baseAt !== null) {
          const fields = changedSince(n as unknown as Record<string, unknown>, set, now.events.get(t.id) ?? [], baseAt, opts.setId ?? null);
          if (fields.length) {
            const ev = (now.events.get(t.id) ?? []).find((e) => e.field && fields.some((f) => f.field === e.field) && new Date(e.at).getTime() > baseAt);
            done({ verdict: "conflicted", code: "value_changed", details: { target: { id: t.id, label: n.label }, fields, at: ev?.at ?? null, by: ev?.by ?? null } });
            break;
          }
        }
        done({ verdict: "outstanding", code: "to_change" });
        break;
      }
      case "retireNode": {
        const t = point(c.nodeId);
        if (!t.ok) { done(t.v.code === "target_retired" || t.v.code === "target_missing" ? { verdict: "landed", code: "already_true" } : t.v); break; }
        const ro = writable(t.id); if (ro && !ro.ok) { done(ro.v); break; }
        done({ verdict: "outstanding", code: "to_retire" });
        break;
      }
      case "mergeNodes": {
        const keepId = String(p(c, "keepId") ?? ""), dropId = String(p(c, "dropId") ?? "");
        if (now.nodes.get(dropId)?.mergedInto === keepId) { done({ verdict: "landed", code: "already_true" }); break; }
        const keep = point(keepId); if (!keep.ok) { done(keep.v); break; }
        const drop = point(dropId); if (!drop.ok) { done(drop.v); break; }
        if (keep.id === drop.id) { done({ verdict: "landed", code: "already_true" }); break; }
        const a = now.nodes.get(keep.id), b = now.nodes.get(drop.id);
        if (a && b && a.type !== b.type) { done({ verdict: "conflicted", code: "different_types", details: { target: { id: b.id, label: b.label }, mergedInto: { id: a.id, label: a.label, type: a.type, kind: a.kind ?? null } } }); break; }
        const ro = writable(keep.id) ?? writable(drop.id); if (ro && !ro.ok) { done(ro.v); break; }
        done({ verdict: "outstanding", code: "to_merge" });
        break;
      }
      case "addEdge": {
        const relation = String(p(c, "relation") ?? "");
        const from = point(String(p(c, "fromId") ?? "")); if (!from.ok) { done(from.v); break; }
        const to = point(String(p(c, "toId") ?? "")); if (!to.ok) { done(to.v); break; }
        if (c.edgeId && now.edges.has(c.edgeId) && !INACTIVE.has(now.edges.get(c.edgeId)!.status)) { done({ verdict: "landed", code: "already_true", details: { edgeId: c.edgeId } }); break; }
        // Both ends turned out to be the same thing: there is nothing to connect.
        if (from.id === to.id) { done({ verdict: "landed", code: "already_true" }); break; }
        const fact = now.triples.get(`${from.id}|${relation}|${to.id}`);
        if (fact) { done({ verdict: "landed", code: "already_true", details: { edgeId: fact } }); break; }
        done({ verdict: "outstanding", code: "to_connect" });
        break;
      }
      case "updateEdge": {
        const e = c.edgeId ? now.edges.get(c.edgeId) : undefined;
        if (!e) { done({ verdict: "conflicted", code: "target_missing", details: { target: { id: c.edgeId ?? "", label: null } } }); break; }
        const set = p<Record<string, unknown>>(c, "set") ?? {};
        done(alreadySays(e as unknown as Record<string, unknown>, set) ? { verdict: "landed", code: "already_true" } : { verdict: "outstanding", code: "to_change" });
        break;
      }
      case "removeEdge": {
        const e = c.edgeId ? now.edges.get(c.edgeId) : undefined;
        done(!e || INACTIVE.has(e.status) ? { verdict: "landed", code: "already_true" } : { verdict: "outstanding", code: "to_remove" });
        break;
      }
      case "addKind":
        done(now.meta.has(`kinds:${p(c, "nodeType")}:${p(c, "key")}`) ? { verdict: "landed", code: "already_true" } : { verdict: "outstanding", code: "model" });
        break;
      case "addRelationType":
        done(now.meta.has(`relations:${p(c, "key")}`) ? { verdict: "landed", code: "already_true" } : { verdict: "outstanding", code: "model" });
        break;
      case "addAttribute":
        done(now.meta.has(`attributes:${p(c, "nodeType")}:${p(c, "kindKey") ?? "*"}:${p(c, "key")}`) ? { verdict: "landed", code: "already_true" } : { verdict: "outstanding", code: "model" });
        break;
      case "addReminder": {
        const about = p<string | null>(c, "aboutNodeId");
        if (about) { const t = point(about); if (!t.ok) { done(t.v); break; } }
        done({ verdict: "outstanding", code: "to_remind" });
        break;
      }
      default:
        done({ verdict: "outstanding", code: "other" });
    }
  }
  return out;
}

/** The fields an update sets that someone else changed after `baseAt`, where the graph now says something else. */
function changedSince(node: Record<string, unknown>, set: Record<string, unknown>, events: NodeEvent[], baseAt: number, setId: string | null) {
  const out: { field: string; now: unknown; proposed: unknown }[] = [];
  const moved = new Set(events.filter((e) => e.field && new Date(e.at).getTime() > baseAt && (!setId || e.changeSetId !== setId)).map((e) => e.field!));
  for (const [k, v] of Object.entries(set)) {
    if (k === "props" && v && typeof v === "object" && !Array.isArray(v)) {
      const props = (node.props ?? {}) as Record<string, unknown>;
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
        if (moved.has(`props.${pk}`) && !valueEq(props[pk], pv)) out.push({ field: `props.${pk}`, now: props[pk] ?? null, proposed: pv });
      }
    } else if (moved.has(k) && !alreadySays(node, { [k]: v })) out.push({ field: k, now: node[k] ?? null, proposed: v });
  }
  return out;
}

/* ── Delivering: what each op does ───────────────────────────────────────────────────────────────────── */

export type DeliveryStep =
  | { action: "apply"; change: ChangeRowLike }
  | { action: "evidence"; change: ChangeRowLike; subject: { type: "node" | "edge"; id: string } }
  | { action: "skip"; change: ChangeRowLike };
export type RemapEntry = { changeId: string; from: string; to: string; label: string; existingLabel: string; via: string };

/**
 * Turn the verdicts of the chosen ops into steps: an "exists" add records its evidence on the existing node and is
 * otherwise skipped; every later op that referred to the new node is pointed at the existing one; a fact that is
 * already true gets this document's evidence; everything outstanding is applied. Conflicted ops are returned so the
 * caller refuses the delivery.
 */
export function planDelivery(chosen: ChangeRowLike[], reasons: Record<string, OpVerdict>) {
  const sorted = [...chosen].sort((a, b) => a.seq - b.seq);
  const conflicts = sorted.filter((c) => reasons[c.id]?.verdict === "conflicted").map((c) => c.id);
  const mapping: Record<string, string> = {};
  const remapped: RemapEntry[] = [];
  for (const c of sorted) {
    const r = reasons[c.id];
    if (c.op === "addNode" && r?.verdict === "exists" && c.nodeId && r.details?.existing) {
      mapping[c.nodeId] = r.details.existing.id;
      remapped.push({ changeId: c.id, from: c.nodeId, to: r.details.existing.id, label: String(c.payload.label ?? ""), existingLabel: r.details.existing.label, via: r.details.existing.via });
    }
  }
  const steps: DeliveryStep[] = [];
  const alreadyTrue: { changeId: string; edgeId: string }[] = [];
  for (const c of sorted) {
    const r = reasons[c.id];
    if (!r || r.verdict === "conflicted") continue;
    if (r.verdict === "exists") { steps.push({ action: "evidence", change: c, subject: { type: "node", id: r.details!.existing!.id } }); continue; }
    if (r.verdict === "landed") {
      if (c.op === "addEdge" && r.details?.edgeId) {
        steps.push({ action: "evidence", change: c, subject: { type: "edge", id: r.details.edgeId } });
        alreadyTrue.push({ changeId: c.id, edgeId: r.details.edgeId });
      } else steps.push({ action: "skip", change: c });
      continue;
    }
    steps.push({ action: "apply", change: remapMinted([c], { ...mapping, ...(r.details?.remap ?? {}) })[0] });
  }
  return { steps, mapping, remapped, alreadyTrue, conflicts };
}

/* ── For people: counts, groups, one line ────────────────────────────────────────────────────────────── */

export type SetSummary = {
  total: number;
  /** Ticked. */
  included: number;
  /** Ticked and deliverable (to do, matching something existing, or already true). */
  ready: number;
  toDo: number;
  exists: number;
  landed: number;
  /** Ticked and needing a person's decision. */
  needsYou: number;
  leftOut: number;
  /** Nothing ticked needs a person. */
  deliverable: boolean;
  /** Everything ticked is already in the graph (only evidence to add). */
  nothingNew: boolean;
};

export function summarize(changes: Pick<ChangeRowLike, "id" | "included">[], reasons: Record<string, Pick<OpVerdict, "verdict">>): SetSummary {
  const s: SetSummary = { total: changes.length, included: 0, ready: 0, toDo: 0, exists: 0, landed: 0, needsYou: 0, leftOut: 0, deliverable: false, nothingNew: false };
  for (const c of changes) {
    if (!c.included) { s.leftOut++; continue; }
    s.included++;
    const v = reasons[c.id]?.verdict ?? "outstanding";
    if (v === "conflicted") { s.needsYou++; continue; }
    s.ready++;
    if (v === "exists") s.exists++;
    else if (v === "landed") s.landed++;
    else s.toDo++;
  }
  s.deliverable = s.included > 0 && s.needsYou === 0;
  s.nothingNew = s.deliverable && s.toDo === 0;
  return s;
}

export type GroupCode = ProblemCode | "exists" | "landed" | "left_out";
export type ReasonGroup = { key: string; code: GroupCode; changeIds: string[]; /** of them, unticked */ leftOut: number; origin?: Origin | null; mergedInto?: NodeRef };

const GROUP_ORDER: GroupCode[] = [...PROBLEM_CODES, "exists", "landed", "left_out"];

/**
 * The review's summary, grouped by what happened: each kind of problem (ticked ops only; merged ones by what they
 * were merged into), then the ones that match existing things (by where those came from, ticked or not, so they can
 * be turned back on), then what is already in the graph, then what was left out.
 */
export function groupReasons(changes: Pick<ChangeRowLike, "id" | "seq" | "included">[], reasons: Record<string, OpVerdict>): ReasonGroup[] {
  const groups = new Map<string, ReasonGroup>();
  const add = (key: string, code: GroupCode, id: string, included: boolean, extra: Partial<ReasonGroup> = {}) => {
    const g = groups.get(key) ?? { key, code, changeIds: [], leftOut: 0, ...extra };
    g.changeIds.push(id);
    if (!included) g.leftOut++;
    groups.set(key, g);
  };
  for (const c of [...changes].sort((a, b) => a.seq - b.seq)) {
    const r = reasons[c.id];
    if (!r) continue;
    if (r.verdict === "exists") {
      const o = r.details?.existing?.origin ?? null;
      add(`exists:${o?.changeSetId ?? o?.sourceId ?? "-"}`, "exists", c.id, c.included, { origin: o });
    } else if (!c.included) add("left_out", "left_out", c.id, false);
    else if (r.verdict === "conflicted") {
      const code = r.code as ProblemCode;
      if (code === "target_merged" && r.details?.mergedInto) add(`target_merged:${r.details.mergedInto.id}`, code, c.id, true, { mergedInto: r.details.mergedInto });
      else add(code, code, c.id, true);
    } else if (r.verdict === "landed") add("landed", "landed", c.id, true);
  }
  return [...groups.values()].sort((a, b) => GROUP_ORDER.indexOf(a.code) - GROUP_ORDER.indexOf(b.code));
}
