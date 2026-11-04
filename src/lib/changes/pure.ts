/**
 * Change sets, pure (no DB): the readable sentence for each op, the fingerprint that makes an old approval stale, the
 * per-op verdict against the graph now (Nexus lib/change/rebase.ts) and a projection of what the graph would look
 * like once a set is delivered (Nexus lib/change/project.ts). A change set never touches the graph until a person
 * delivers it; these functions only look.
 */
import type { ChangeOp } from "./index";
import type { EdgeSnap, GraphState, NodeSnap } from "@/lib/history/pure";

export type Verdict = "outstanding" | "landed" | "conflicted";

export const NODE_OPS = new Set(["addNode", "updateNode", "retireNode", "mergeNodes"]);
export const EDGE_OPS = new Set(["addEdge", "updateEdge", "removeEdge"]);
export const META_OPS = new Set(["addKind", "addRelationType", "addAttribute"]);
export const ALL_OPS = new Set([...NODE_OPS, ...EDGE_OPS, ...META_OPS, "addReminder", "editWiki"]);

/** A stored change as the pure functions see it. */
export type ChangeRowLike = { id: string; seq: number; op: string; nodeId: string | null; edgeId: string | null; payload: Record<string, unknown>; included: boolean };

export const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/* ── Who sees a change set ───────────────────────────────────────────────────────────────────────────── */

/**
 * A change set is visible to a viewer only inside its own graph, and only when it is theirs (they proposed it or it
 * waits for them) — or nobody's in particular (a connector, the system) and they may write in that graph. Anything
 * else reads as "not found" — except a proposal whose evidence every writer may read (see evidenceOpen): that one
 * is open to every writer in the graph, so a co-parent sees what an import of a shared file proposes.
 */
export function canSeeSet(v: { id: string; graphId: string | null; canWrite: boolean }, row: { graphId: string; createdBy: string | null; forUserId: string | null; openEvidence?: boolean }): boolean {
  if (!v.graphId || row.graphId !== v.graphId) return false;
  if (row.createdBy === v.id || row.forUserId === v.id) return true;
  if (!v.canWrite) return false;
  return (!row.createdBy && !row.forUserId) || !!row.openEvidence;
}

/* ── Fingerprint ─────────────────────────────────────────────────────────────────────────────────────── */

/** Two independent 32-bit FNV-1a passes; enough to notice any change to the ops, not a security boundary. */
function hash(text: string): string {
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
    b = (b ^ (b >>> 13)) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

function stable(x: unknown): string {
  if (x === null || typeof x !== "object") return JSON.stringify(x ?? null);
  if (Array.isArray(x)) return `[${x.map(stable).join(",")}]`;
  const o = x as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
}

/** Over every op (which, in what order, with what payload and whether it is ticked). Any edit changes it. */
export function fingerprintOf(changes: ChangeRowLike[]): string {
  const ordered = [...changes].sort((a, b) => a.seq - b.seq);
  return hash(stable(ordered.map((c) => ({ id: c.id, op: c.op, nodeId: c.nodeId, edgeId: c.edgeId, payload: c.payload, included: c.included }))));
}

/* ── The graph now, as verdicts need it ──────────────────────────────────────────────────────────────── */

export type Now = {
  /** Nodes the person delivering can see (merged ones included, flagged by mergedInto). */
  nodes: Map<string, Pick<NodeSnap, "id" | "type" | "label" | "aliases" | "summary" | "kind" | "props" | "startAt" | "endAt" | "visibility" | "sensitive" | "mergedInto">>;
  edges: Map<string, Pick<EdgeSnap, "id" | "fromId" | "toId" | "relation" | "status" | "confidence" | "validFrom" | "validTo" | "visibility">>;
  /** Active facts, as `from|relation|to`. */
  triples: Set<string>;
  /** Live nodes by `type:normalised label` (and alias). */
  names: Map<string, string>;
  /** Model elements this graph sees: `kinds:type:key`, `relations:key`, `attributes:type:kind:key`. */
  meta: Set<string>;
};

export function emptyNow(): Now {
  return { nodes: new Map(), edges: new Map(), triples: new Set(), names: new Map(), meta: new Set() };
}

const INACTIVE = new Set(["rejected", "superseded"]);
const p = <T = unknown>(c: ChangeRowLike, k: string) => c.payload[k] as T;

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

/**
 * Replay each op onto the graph now. outstanding = still to do; landed = the graph already says it (somebody got there
 * first, or it was delivered); conflicted = the graph moved where the op can't be replayed (something it needs is gone
 * or no longer visible, or a thing with that name was added outside this proposal). Conflicted ops are never delivered.
 */
export function verdictsFor(changes: ChangeRowLike[], now: Now, opts: { includedOnly?: boolean } = {}): Record<string, { verdict: Verdict; why: string }> {
  const out: Record<string, { verdict: Verdict; why: string }> = {};
  const live = (id: string | null | undefined) => {
    const n = id ? now.nodes.get(id) : undefined;
    return n && !n.mergedInto ? n : undefined;
  };
  const addedHere = new Set(changes.filter((c) => c.op === "addNode" && c.nodeId && (!opts.includedOnly || c.included)).map((c) => c.nodeId!));
  for (const c of changes) {
    const say = (verdict: Verdict, why: string) => { out[c.id] = { verdict, why }; };
    switch (c.op) {
      case "addNode": {
        if (c.nodeId && now.nodes.has(c.nodeId)) { say("landed", "exists"); break; }
        const label = String(p(c, "label") ?? "");
        const other = now.names.get(`${String(p(c, "type") ?? "")}:${norm(label)}`);
        if (label && other && other !== c.nodeId) { say("conflicted", "sameName"); break; }
        say("outstanding", "toAdd");
        break;
      }
      case "updateNode": {
        const n = live(c.nodeId);
        if (!n) { say("conflicted", "gone"); break; }
        const set = (p<Record<string, unknown>>(c, "set") ?? {});
        say(alreadySays(n as unknown as Record<string, unknown>, set) ? "landed" : "outstanding", "toChange");
        break;
      }
      case "retireNode": {
        const n = live(c.nodeId);
        if (!n || n.props?.retired === true) { say("landed", "gone"); break; }
        say("outstanding", "toRetire");
        break;
      }
      case "mergeNodes": {
        const keepId = String(p(c, "keepId") ?? ""), dropId = String(p(c, "dropId") ?? "");
        const drop = now.nodes.get(dropId);
        if (drop?.mergedInto === keepId) { say("landed", "merged"); break; }
        if (!live(keepId) || !live(dropId)) { say("conflicted", "gone"); break; }
        if (live(keepId)!.type !== live(dropId)!.type) { say("conflicted", "differentTypes"); break; }
        say("outstanding", "toMerge");
        break;
      }
      case "addEdge": {
        const fromId = String(p(c, "fromId") ?? ""), toId = String(p(c, "toId") ?? ""), relation = String(p(c, "relation") ?? "");
        const endOk = (id: string) => !!live(id) || addedHere.has(id);
        if (!endOk(fromId) || !endOk(toId)) { say("conflicted", "endGone"); break; }
        if (c.edgeId && now.edges.has(c.edgeId) && !INACTIVE.has(now.edges.get(c.edgeId)!.status)) { say("landed", "exists"); break; }
        if (now.triples.has(`${fromId}|${relation}|${toId}`)) { say("landed", "exists"); break; }
        say("outstanding", "toConnect");
        break;
      }
      case "updateEdge": {
        const e = c.edgeId ? now.edges.get(c.edgeId) : undefined;
        if (!e) { say("conflicted", "gone"); break; }
        const set = (p<Record<string, unknown>>(c, "set") ?? {});
        say(alreadySays(e as unknown as Record<string, unknown>, set) ? "landed" : "outstanding", "toChange");
        break;
      }
      case "removeEdge": {
        const e = c.edgeId ? now.edges.get(c.edgeId) : undefined;
        say(!e || INACTIVE.has(e.status) ? "landed" : "outstanding", "toRemove");
        break;
      }
      case "addKind":
        say(now.meta.has(`kinds:${p(c, "nodeType")}:${p(c, "key")}`) ? "landed" : "outstanding", "model");
        break;
      case "addRelationType":
        say(now.meta.has(`relations:${p(c, "key")}`) ? "landed" : "outstanding", "model");
        break;
      case "addAttribute":
        say(now.meta.has(`attributes:${p(c, "nodeType")}:${p(c, "kindKey") ?? "*"}:${p(c, "key")}`) ? "landed" : "outstanding", "model");
        break;
      case "addReminder":
        say(p(c, "aboutNodeId") && !live(String(p(c, "aboutNodeId"))) && !addedHere.has(String(p(c, "aboutNodeId"))) ? "conflicted" : "outstanding", "toRemind");
        break;
      default:
        say("outstanding", "other");
    }
  }
  return out;
}

/* ── Sentences ───────────────────────────────────────────────────────────────────────────────────────── */

/**
 * The thing each op is about, as a person would name it: "Anna", "Anna · goes to · Ny Skole", "Teacher". Names come
 * from the graph (what the reader may see), then from addNode ops in the same set; an unknown end reads "someone".
 */
export function summaryOf(c: ChangeRowLike, names: (id: string) => string | null, relationLabel: (key: string) => string = (k) => k.replace(/_/g, " ")): string {
  const name = (id: unknown) => (typeof id === "string" && names(id)) || "…";
  const s = (k: string) => (typeof c.payload[k] === "string" ? String(c.payload[k]) : "");
  switch (c.op) {
    case "addNode": return s("label") || "…";
    case "updateNode": return name(c.nodeId);
    case "retireNode": return name(c.nodeId);
    case "mergeNodes": return `${name(c.payload.dropId)} → ${name(c.payload.keepId)}`;
    case "addEdge": return `${name(c.payload.fromId)} · ${relationLabel(s("relation"))} · ${name(c.payload.toId)}`;
    case "updateEdge":
    case "removeEdge": return s("name") || name(c.edgeId);
    case "addKind": return s("label") || s("key");
    case "addRelationType": return s("inverseLabel") && s("inverseLabel") !== s("label") ? `${s("label")} / ${s("inverseLabel")}` : s("label") || s("key");
    case "addAttribute": return s("label") || s("key");
    case "addReminder": return s("title");
    case "editWiki": return s("title") || s("slug");
    default: return c.op;
  }
}

/** Split an op's input into stored columns: node/edge ids pulled out, everything else the payload. */
export function toStored(op: ChangeOp, mint: () => string): { op: string; nodeId: string | null; edgeId: string | null; payload: Record<string, unknown> } {
  const { op: name, ...rest } = op as ChangeOp & Record<string, unknown>;
  const payload: Record<string, unknown> = { ...rest };
  delete payload.note; delete payload.receipt;
  let nodeId: string | null = null, edgeId: string | null = null;
  if (name === "addNode") { nodeId = (op as { nodeId?: string }).nodeId ?? mint(); delete payload.nodeId; }
  else if (name === "updateNode" || name === "retireNode") { nodeId = (op as { nodeId: string }).nodeId; delete payload.nodeId; }
  else if (name === "mergeNodes") nodeId = (op as { keepId: string }).keepId;
  else if (name === "addEdge") { edgeId = (op as { edgeId?: string }).edgeId ?? mint(); delete payload.edgeId; }
  else if (name === "updateEdge" || name === "removeEdge") { edgeId = (op as { edgeId: string }).edgeId; delete payload.edgeId; }
  else if (name === "addReminder") nodeId = (op as { aboutNodeId?: string | null }).aboutNodeId ?? null;
  return { op: name, nodeId, edgeId, payload };
}

/* ── Projection ──────────────────────────────────────────────────────────────────────────────────────── */

export type Projection = GraphState & { added: Set<string>; changed: Set<string>; retired: Set<string>; addedEdges: Set<string>; removedEdges: Set<string>; problems: { changeId: string; why: string }[] };

/**
 * The graph after these ops — in memory, never the database. What lets a person see a proposal's effect before they
 * deliver it. Ops that no longer make sense are reported, not skipped silently.
 */
export function project(state: GraphState, changes: ChangeRowLike[], at = new Date()): Projection {
  const nodes = new Map([...state.nodes].map(([k, v]) => [k, { ...v, props: { ...v.props } }]));
  const edges = new Map([...state.edges].map(([k, v]) => [k, { ...v }]));
  const out: Projection = { nodes, edges, added: new Set(), changed: new Set(), retired: new Set(), addedEdges: new Set(), removedEdges: new Set(), problems: [] };
  const now = at.toISOString();
  for (const c of [...changes].filter((x) => x.included).sort((a, b) => a.seq - b.seq)) {
    const pl = c.payload;
    switch (c.op) {
      case "addNode": {
        if (!c.nodeId) { out.problems.push({ changeId: c.id, why: "noId" }); break; }
        if (!nodes.has(c.nodeId)) {
          nodes.set(c.nodeId, {
            id: c.nodeId, graphId: "", ownerId: "", householdId: "", type: String(pl.type ?? "thing"), kind: (pl.kind as string) ?? null, label: String(pl.label ?? ""),
            aliases: (pl.aliases as string[]) ?? [], summary: (pl.summary as string) ?? null, props: (pl.props as Record<string, unknown>) ?? {},
            startAt: (pl.startAt as string) ?? null, endAt: (pl.endAt as string) ?? null, timePrecision: null,
            visibility: (pl.visibility as NodeSnap["visibility"]) ?? "private", sensitive: false, mergedInto: null,
          });
        }
        out.added.add(c.nodeId);
        break;
      }
      case "updateNode": {
        const n = c.nodeId ? nodes.get(c.nodeId) : undefined;
        if (!n) { out.problems.push({ changeId: c.id, why: "gone" }); break; }
        const set = (pl.set as Record<string, unknown>) ?? {};
        for (const [k, v] of Object.entries(set)) {
          if (k === "props" && v && typeof v === "object") n.props = { ...n.props, ...(v as Record<string, unknown>) };
          else (n as Record<string, unknown>)[k] = v instanceof Date ? v.toISOString() : v;
        }
        out.changed.add(n.id);
        break;
      }
      case "retireNode": {
        const n = c.nodeId ? nodes.get(c.nodeId) : undefined;
        if (!n) { out.problems.push({ changeId: c.id, why: "gone" }); break; }
        n.props = { ...n.props, retired: true, retiredAt: now };
        out.retired.add(n.id);
        for (const [id, e] of edges) if (e.fromId === n.id || e.toId === n.id) { e.status = "superseded"; out.removedEdges.add(id); }
        break;
      }
      case "mergeNodes": {
        const keep = nodes.get(String(pl.keepId)), drop = nodes.get(String(pl.dropId));
        if (!keep || !drop) { out.problems.push({ changeId: c.id, why: "gone" }); break; }
        drop.mergedInto = keep.id;
        keep.aliases = [...new Set([...keep.aliases, drop.label, ...drop.aliases])];
        for (const e of edges.values()) { if (e.fromId === drop.id) e.fromId = keep.id; if (e.toId === drop.id) e.toId = keep.id; }
        out.changed.add(keep.id); out.retired.add(drop.id);
        break;
      }
      case "addEdge": {
        const fromId = String(pl.fromId ?? ""), toId = String(pl.toId ?? "");
        if (!nodes.has(fromId) || !nodes.has(toId)) { out.problems.push({ changeId: c.id, why: "endGone" }); break; }
        const id = c.edgeId ?? c.id;
        edges.set(id, {
          id, graphId: "", ownerId: "", householdId: "", fromId, toId, relation: String(pl.relation ?? ""), status: String(pl.status ?? "unconfirmed"),
          confidence: typeof pl.confidence === "number" ? pl.confidence : 1, visibility: "private", validFrom: null, validTo: null,
        });
        out.addedEdges.add(id);
        break;
      }
      case "updateEdge": {
        const e = c.edgeId ? edges.get(c.edgeId) : undefined;
        if (!e) { out.problems.push({ changeId: c.id, why: "gone" }); break; }
        Object.assign(e, (pl.set as Record<string, unknown>) ?? {});
        break;
      }
      case "removeEdge": {
        const e = c.edgeId ? edges.get(c.edgeId) : undefined;
        if (!e) { out.problems.push({ changeId: c.id, why: "gone" }); break; }
        e.status = "rejected";
        out.removedEdges.add(e.id);
        break;
      }
    }
  }
  return out;
}

/* ── Partly delivered: what keeps waiting ────────────────────────────────────────────────────────────── */

/** "Rest of …" for the follow-up set, never longer than a title may be and never "Rest of Rest of …". */
export function restTitle(title: string, prefix = "Rest of"): string {
  const base = title.replace(new RegExp(`^(${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+)+`, "i"), "").trim() || title;
  return `${prefix} ${base}`.slice(0, 200);
}

/**
 * When only some ops of a set are delivered, the others keep waiting: they move to a follow-up set (ticked again,
 * renumbered from 1, in their old order). Ops that were delivered or that the graph already said stay behind.
 */
export function restOf<T extends ChangeRowLike>(all: T[], delivered: Set<string>): (T & { seq: number; included: true })[] {
  return [...all].sort((a, b) => a.seq - b.seq).filter((c) => !delivered.has(c.id)).map((c, i) => ({ ...c, seq: i + 1, included: true as const }));
}

/* ── Merging repeated updates (cross-graph propagation) ──────────────────────────────────────────────── */

/** A newer `set` on top of an older one: newer fields win, props merge key by key. */
export function mergeUpdateSet(older: Record<string, unknown>, newer: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...older, ...newer };
  const a = older.props, b = newer.props;
  if (a && typeof a === "object" && !Array.isArray(a) && b && typeof b === "object" && !Array.isArray(b)) {
    out.props = { ...(a as Record<string, unknown>), ...(b as Record<string, unknown>) };
  }
  return out;
}

/* ── Whose eyes a proposal's evidence is for ─────────────────────────────────────────────────────────── */

export type EvidenceRefs = { sourceIds: string[]; conversationIds: string[]; /** a quote or message with no source to check it against */ unanchored: boolean };

/** Everything a set cites: its own evidence and every op's receipt. */
export function evidenceRefs(setEvidence: Record<string, unknown> | null | undefined, receipts: (Record<string, unknown> | null | undefined)[]): EvidenceRefs {
  const sources = new Set<string>(), conversations = new Set<string>();
  let unanchored = false;
  for (const r of [setEvidence, ...receipts]) {
    if (!r) continue;
    const s = typeof r.sourceId === "string" && r.sourceId ? r.sourceId : null;
    const c = typeof r.conversationId === "string" && r.conversationId ? r.conversationId : null;
    if (s) sources.add(s);
    if (c) conversations.add(c);
    if (!s && !c && ((typeof r.quote === "string" && r.quote.trim()) || typeof r.messageId === "string")) unanchored = true;
  }
  return { sourceIds: [...sources], conversationIds: [...conversations], unanchored };
}

/**
 * A proposal is open to every writer in the graph when everything it cites is something they may read: at least one
 * source, every source readable to the household writer looking, no conversation (chats belong to the person who
 * had them) and no quote without a source behind it. Anything else stays with the proposer and whoever it waits for.
 */
export function evidenceOpen(refs: EvidenceRefs, readable: (sourceId: string) => boolean, ownConversation: (conversationId: string) => boolean = () => false): boolean {
  if (refs.unanchored || !refs.sourceIds.length) return false;
  if (!refs.conversationIds.every(ownConversation)) return false;
  return refs.sourceIds.every(readable);
}

/* ── Bringing a retired node back ────────────────────────────────────────────────────────────────────── */

/**
 * The ops that bring a retired node back, as a proposal: clear the retired marker, and give back the facts that were
 * replaced when it was retired (history says which, and what they were before) if they are still replaced now.
 */
export function restoreRetiredOps(
  node: { id: string; props: Record<string, unknown> },
  replacedAtRetire: { edgeId: string; was: unknown }[],
  edgesNow: Map<string, { status: string }>,
  note = "Bring back what was retired",
): ChangeOp[] {
  if (node.props?.retired !== true && node.props?.retired !== "true") return [];
  const ops: ChangeOp[] = [{ op: "updateNode", nodeId: node.id, set: { props: { retired: null, retiredAt: null } }, note } as ChangeOp];
  const seen = new Set<string>();
  for (const r of replacedAtRetire) {
    if (seen.has(r.edgeId)) continue;
    seen.add(r.edgeId);
    const was = typeof r.was === "string" && ["confirmed", "unconfirmed", "inferred"].includes(r.was) ? r.was : null;
    if (!was || edgesNow.get(r.edgeId)?.status !== "superseded") continue;
    ops.push({ op: "updateEdge", edgeId: r.edgeId, set: { status: was }, note } as ChangeOp);
  }
  return ops;
}
