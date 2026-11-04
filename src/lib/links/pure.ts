/**
 * Cross-graph objects, pure rules (no DB, no Next) so the API, the UI and the tests share one definition.
 *
 * An identity is one real-world person (or thing) with a node in several graphs. The rules:
 *  - Who sees a link: only someone who is a member of BOTH graphs and can read the node on the other side. Everyone
 *    else sees their own graph's node and nothing about the link (no count, no dot, no hint).
 *  - What travels: only the fields the person chose when sharing or connecting. Never facts (edges), sources,
 *    provenance, memories, private notes or sensitive attributes.
 *  - Changes travel as proposals (change sets) in the other graph, for its members to deliver. Never a silent sync.
 */

/** A field that may travel: "label", "kind", "aliases", "summary" or "props.<attributeKey>". */
export type FieldKey = string;

export const CORE_FIELDS = ["label", "kind", "aliases", "summary"] as const;

/** The parts of a node sharing looks at. */
export type ShareableNode = {
  type: string; kind?: string | null; label: string; aliases: string[]; summary: string | null; props: Record<string, unknown>;
};

/** The parts of a meta attribute sharing looks at. */
export type AttrLite = { key: string; label: string; dataType: string; sensitive: boolean };

export type FieldOption = { key: FieldKey; label: string; preview: string; defaultOn: boolean; required: boolean };

/** Attribute types that are contact details: ticked by default when sharing. */
const CONTACT_TYPES = new Set(["email", "phone", "url"]);
/** Prop keys that are never shared, whatever the meta model says (notes, internal markers, identifiers). */
const NEVER_KEYS = /(^|_)(note|notes|private|secret|cpr|password|token)(_|$)|^gbrain/i;

export function isEmptyValue(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && v.length === 0);
}

/** An attribute may travel when it is declared for the kind, is not long free text (notes) and is not sensitive. */
export function attributeShareable(a: AttrLite): boolean {
  return a.dataType !== "longtext" && !a.sensitive && !NEVER_KEYS.test(a.key);
}

function preview(v: unknown): string {
  if (Array.isArray(v)) return v.join(", ");
  if (v && typeof v === "object") return "";
  return String(v ?? "");
}

/**
 * The fields of `node` a person may choose to share, with sensible defaults: name always, kind and other names
 * when set, contact details on, the description and other attributes off.
 */
export function shareableFields(node: ShareableNode, attrs: AttrLite[], labels: { label: string; kind: string; aliases: string; summary: string }): FieldOption[] {
  const out: FieldOption[] = [{ key: "label", label: labels.label, preview: node.label, defaultOn: true, required: true }];
  if (node.kind) out.push({ key: "kind", label: labels.kind, preview: node.kind, defaultOn: true, required: false });
  if (node.aliases.length) out.push({ key: "aliases", label: labels.aliases, preview: node.aliases.join(", "), defaultOn: true, required: false });
  if (node.summary?.trim()) out.push({ key: "summary", label: labels.summary, preview: node.summary.trim(), defaultOn: false, required: false });
  for (const a of attrs) {
    if (!attributeShareable(a)) continue;
    const v = node.props[a.key];
    if (isEmptyValue(v) || (typeof v === "object" && !Array.isArray(v))) continue;
    out.push({ key: `props.${a.key}`, label: a.label, preview: preview(v), defaultOn: CONTACT_TYPES.has(a.dataType), required: false });
  }
  return out;
}

/** The chosen fields, cut down to the ones that may travel ("label" is always included). */
export function allowedFields(chosen: FieldKey[], options: FieldOption[]): FieldKey[] {
  const ok = new Set(options.map((o) => o.key));
  const out = new Set<FieldKey>(["label"]);
  for (const k of chosen) if (ok.has(k)) out.add(k);
  return [...out];
}

export type SharedPayload = { label: string; kind?: string | null; aliases?: string[]; summary?: string; props: Record<string, unknown> };

/** What a copy in another graph receives: only the given fields. */
export function pickFields(node: ShareableNode, fields: FieldKey[]): SharedPayload {
  const f = new Set(fields);
  const out: SharedPayload = { label: node.label, props: {} };
  if (f.has("kind") && node.kind) out.kind = node.kind;
  if (f.has("aliases") && node.aliases.length) out.aliases = [...node.aliases];
  if (f.has("summary") && node.summary?.trim()) out.summary = node.summary.trim();
  for (const k of f) {
    if (!k.startsWith("props.")) continue;
    const key = k.slice(6);
    if (NEVER_KEYS.test(key)) continue;
    const v = node.props[key];
    if (!isEmptyValue(v)) out.props[key] = v;
  }
  return out;
}

/** Field keys that moved between two versions of a node (what callers pass to onNodeChanged). */
export function changedFieldKeys(before: Partial<ShareableNode>, after: Partial<ShareableNode>): FieldKey[] {
  const out: FieldKey[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  for (const k of CORE_FIELDS) if (k in after && !same(before[k], after[k])) out.push(k);
  if (after.props) {
    const keys = new Set([...Object.keys(before.props ?? {}), ...Object.keys(after.props)]);
    for (const k of keys) if (!same(before.props?.[k], after.props[k])) out.push(`props.${k}`);
  }
  return out;
}

/** The changed fields that travel from one linked node to another: only those both sides agreed to share. */
export function fieldsToPropagate(changed: FieldKey[], fromFields: FieldKey[], toFields: FieldKey[]): FieldKey[] {
  const a = new Set(fromFields), b = new Set(toFields);
  return [...new Set(changed)].filter((k) => a.has(k) && b.has(k));
}

/** The `set` of an updateNode op that brings `target` in line with `source` for these fields; null when nothing differs. */
export function updateSetFor(source: ShareableNode, target: ShareableNode, fields: FieldKey[]): Record<string, unknown> | null {
  const set: Record<string, unknown> = {};
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  for (const k of fields) {
    if (k === "label" && source.label.trim() && !same(source.label, target.label)) set.label = source.label;
    else if (k === "kind" && !same(source.kind, target.kind)) set.kind = source.kind ?? null;
    else if (k === "aliases" && !same(source.aliases, target.aliases)) set.aliases = source.aliases;
    else if (k === "summary" && !same(source.summary, target.summary)) set.summary = source.summary ?? null;
    else if (k.startsWith("props.")) {
      const key = k.slice(6);
      if (NEVER_KEYS.test(key)) continue;
      if (!same(source.props[key], target.props[key])) {
        const props = (set.props as Record<string, unknown> | undefined) ?? { ...target.props };
        if (isEmptyValue(source.props[key])) delete props[key]; else props[key] = source.props[key];
        set.props = props;
      }
    }
  }
  return Object.keys(set).length ? set : null;
}

/* ── Who sees what ──────────────────────────────────────────────────────────────────────────────────── */

export type MemberRow = { id: string; identityId: string; graphId: string; nodeId: string; status: string; shareFields: FieldKey[]; changeSetId: string | null };

/**
 * The other members of an identity this viewer may know about: in a graph they belong to, and (for a delivered
 * link) a node they can read there. `readable` holds the node ids that passed the access check in their graph.
 * The node being viewed must itself be readable, or nothing is shown.
 */
export function visibleOthers(members: MemberRow[], p: { nodeId: string; myGraphIds: Set<string>; readable: Set<string> }): MemberRow[] {
  const me = members.find((m) => m.nodeId === p.nodeId);
  if (!me || !p.myGraphIds.has(me.graphId)) return [];
  return members.filter((m) => m.nodeId !== p.nodeId && m.graphId !== me.graphId && p.myGraphIds.has(m.graphId)
    && (m.status === "pending" || p.readable.has(m.nodeId)));
}

/** Graphs a node may be shared into: ones I'm a member of and may write in, other than its own, with no copy yet. */
export function shareTargets<G extends { id: string; canWrite: boolean; archived?: boolean }>(graphs: G[], p: { currentGraphId: string; linkedGraphIds: Set<string> }): G[] {
  return graphs.filter((g) => g.id !== p.currentGraphId && g.canWrite && !g.archived && !p.linkedGraphIds.has(g.id));
}

/* ── Propagation (proposals, never writes) ─────────────────────────────────────────────────────────── */

export type PropagationTarget = { graphId: string; nodeId: string; shareFields: FieldKey[]; node: ShareableNode };
export type PlannedProposal = { graphId: string; nodeId: string; fields: FieldKey[]; set: Record<string, unknown> };

/** For a change on `source`, the updateNode proposals each linked node should get (only fields both agreed on). */
export function planPropagation(p: { source: ShareableNode; sourceFields: FieldKey[]; changed: FieldKey[]; targets: PropagationTarget[] }): PlannedProposal[] {
  const out: PlannedProposal[] = [];
  for (const t of p.targets) {
    const fields = fieldsToPropagate(p.changed, p.sourceFields, t.shareFields);
    if (!fields.length) continue;
    const set = updateSetFor(p.source, t.node, fields);
    if (set) out.push({ graphId: t.graphId, nodeId: t.nodeId, fields, set });
  }
  return out;
}

/** Who a proposal in a linked graph waits for: the changer when they're a member there, else whoever linked it. */
export function proposerFor(p: { changerId: string; changerGraphIds: Set<string>; targetGraphId: string; linkedBy: string | null; linkerGraphIds: Set<string> | null; sourceGraphId: string }): string | null {
  if (p.changerGraphIds.has(p.targetGraphId)) return p.changerId;
  if (p.linkedBy && p.linkerGraphIds?.has(p.targetGraphId) && p.linkerGraphIds.has(p.sourceGraphId)) return p.linkedBy;
  return null;
}

/* ── Unlinking ──────────────────────────────────────────────────────────────────────────────────────── */

/** After removing `nodeIds` from an identity: the members that stay, and whether the identity dissolves (≤ 1 left). */
export function afterUnlink(members: MemberRow[], nodeIds: string[]): { remaining: MemberRow[]; dissolve: boolean } {
  const drop = new Set(nodeIds);
  const remaining = members.filter((m) => !drop.has(m.nodeId));
  return { remaining, dissolve: remaining.length <= 1 };
}
