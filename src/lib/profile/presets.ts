/**
 * Facts written from a profile (pure): the one-click presets ("Add a pet", "Add a child") and the ops a fact turns
 * into. A fact is an edge between the profile's node and another node, existing or new; when the graph's model lacks
 * the relation type or the kind (a family graph has no "owns" or "Pet" until someone adds a pet), the ops add them
 * too, so the whole fact lands in one change set.
 */
import type { FactPresetKey } from "./types";

export type PresetDef = {
  relation: string; direction: "out" | "in"; otherType: string; kind: string | null;
  /** Used when the graph's model has no such relation yet. */
  relationDef?: { label: string; inverseLabel: string; category: string; fromTypes: string[]; toTypes: string[] };
  /** Used when the graph's model has no such kind yet. */
  kindDef?: { label: string; pluralLabel: string };
  /** The kind can be named by the writer ("Dog", "Cat") instead of the preset's. */
  namedKind?: boolean;
};

const PERSON = ["person"];

export const PRESETS: Record<FactPresetKey, Partial<Record<string, PresetDef>>> = {
  partner: { person: { relation: "partner_of", direction: "out", otherType: "person", kind: "partner" } },
  child: { person: { relation: "parent_of", direction: "out", otherType: "person", kind: "child" } },
  parent: { person: { relation: "parent_of", direction: "in", otherType: "person", kind: "parent" } },
  sibling: { person: { relation: "sibling_of", direction: "out", otherType: "person", kind: "sibling" } },
  pet: { person: { relation: "owns", direction: "out", otherType: "thing", kind: "pet", namedKind: true,
    relationDef: { label: "owns", inverseLabel: "owned by", category: "other", fromTypes: PERSON, toTypes: ["thing"] }, kindDef: { label: "Pet", pluralLabel: "Pets" } } },
  home: { person: { relation: "located_at", direction: "out", otherType: "place", kind: "home",
    relationDef: { label: "located at", inverseLabel: "location of", category: "place", fromTypes: [], toTypes: ["place"] }, kindDef: { label: "Home", pluralLabel: "Homes" } } },
  car: { person: { relation: "owns", direction: "out", otherType: "thing", kind: "car",
    relationDef: { label: "owns", inverseLabel: "owned by", category: "other", fromTypes: PERSON, toTypes: ["thing"] }, kindDef: { label: "Car", pluralLabel: "Cars" } } },
  belonging: { person: { relation: "owns", direction: "out", otherType: "thing", kind: "possession", namedKind: true,
    relationDef: { label: "owns", inverseLabel: "owned by", category: "other", fromTypes: PERSON, toTypes: ["thing"] }, kindDef: { label: "Belonging", pluralLabel: "Belongings" } } },
  workplace: { person: { relation: "member_of", direction: "out", otherType: "organization", kind: null,
    relationDef: { label: "member of", inverseLabel: "has member", category: "work", fromTypes: PERSON, toTypes: ["organization"] } } },
  school: { person: { relation: "attends", direction: "out", otherType: "place", kind: "school",
    relationDef: { label: "attends", inverseLabel: "attended by", category: "school", fromTypes: PERSON, toTypes: ["place", "event"] }, kindDef: { label: "School", pluralLabel: "Schools" } } },
  interest: { person: { relation: "interested_in", direction: "out", otherType: "topic", kind: "interest",
    relationDef: { label: "interested in", inverseLabel: "interest of", category: "social", fromTypes: PERSON, toTypes: ["topic", "project", "thing"] }, kindDef: { label: "Interest", pluralLabel: "Interests" } } },
  doctor: { person: { relation: "treated_by", direction: "out", otherType: "person", kind: "doctor",
    relationDef: { label: "treated by", inverseLabel: "treats", category: "care", fromTypes: PERSON, toTypes: ["person", "place"] } } },
  friend: { person: { relation: "friend_of", direction: "out", otherType: "person", kind: "friend" } },
  member: {
    organization: { relation: "member_of", direction: "in", otherType: "person", kind: null,
      relationDef: { label: "member of", inverseLabel: "has member", category: "work", fromTypes: PERSON, toTypes: ["organization"] } },
    project: { relation: "works_on", direction: "in", otherType: "person", kind: null,
      relationDef: { label: "works on", inverseLabel: "worked on by", category: "work", fromTypes: PERSON, toTypes: ["project", "topic", "thing"] } },
  },
  project: { organization: { relation: "belongs_to", direction: "in", otherType: "project", kind: null,
    relationDef: { label: "belongs to", inverseLabel: "has", category: "work", fromTypes: ["project", "organization", "thing", "topic"], toTypes: ["organization", "project"] } } },
  place: {
    "*": { relation: "located_at", direction: "out", otherType: "place", kind: null,
      relationDef: { label: "located at", inverseLabel: "location of", category: "place", fromTypes: [], toTypes: ["place"] } },
    event: { relation: "happened_at", direction: "out", otherType: "place", kind: null,
      relationDef: { label: "happened at", inverseLabel: "place of", category: "place", fromTypes: ["event"], toTypes: ["place"] } },
  },
  relation: {},
};

export function presetFor(key: FactPresetKey, subjectType: string): PresetDef | null {
  const p = PRESETS[key];
  return p[subjectType] ?? p["*"] ?? null;
}

/** "Golden retriever" → "golden_retriever": a kind key from what someone typed. */
export function kindKeyOf(label: string): string {
  return label.trim().toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/æ/g, "ae").replace(/ø/g, "oe").replace(/å/g, "aa")
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 50) || "other";
}

export type FactInput = {
  relation: string; direction: "out" | "in";
  other: { id: string } | { label: string; type: string; kind: string | null; kindLabel?: string | null };
  relationDef?: PresetDef["relationDef"];
  kindDef?: PresetDef["kindDef"];
  note?: string;
};

export type ModelLike = {
  hasRelation: (key: string) => boolean;
  hasKind: (type: string, key: string) => boolean;
};

export type FactOp =
  | { op: "addRelationType"; key: string; label: string; inverseLabel: string; category: string; fromTypes: string[]; toTypes: string[]; note: string; receipt: Record<string, unknown> }
  | { op: "addKind"; nodeType: string; key: string; label: string; pluralLabel: string; note: string; receipt: Record<string, unknown> }
  | { op: "addNode"; nodeId: string; type: string; kind: string | null; label: string; note: string; receipt: Record<string, unknown> }
  | { op: "addEdge"; fromId: string; toId: string; relation: string; status: "confirmed"; confidence: number; note: string; receipt: Record<string, unknown> };

export class FactError extends Error {}

/**
 * The ops for one fact written on a profile: model ops it needs, the new thing (if any) and the edge. Throws
 * FactError when the relation is unknown and no definition came with it.
 */
export function factOps(subjectId: string, f: FactInput, model: ModelLike, opts: { mint: () => string; receipt: Record<string, unknown> }): { ops: FactOp[]; otherId: string } {
  const ops: FactOp[] = [];
  const receipt = opts.receipt;
  if (!model.hasRelation(f.relation)) {
    if (!f.relationDef) throw new FactError("That kind of connection isn't in this graph's model.");
    ops.push({ op: "addRelationType", key: f.relation, ...f.relationDef, note: `New connection “${f.relationDef.label}”`, receipt });
  }
  let otherId: string;
  if ("id" in f.other) {
    otherId = f.other.id;
    if (otherId === subjectId) throw new FactError("A fact needs two different things.");
  } else {
    const o = f.other;
    const label = o.label.trim();
    if (!label) throw new FactError("Give it a name.");
    let kind = o.kind;
    if (kind && !model.hasKind(o.type, kind)) {
      const kl = (o.kindLabel ?? f.kindDef?.label ?? kind).trim();
      ops.push({ op: "addKind", nodeType: o.type, key: kind, label: kl.charAt(0).toUpperCase() + kl.slice(1), pluralLabel: f.kindDef && kl === f.kindDef.label ? f.kindDef.pluralLabel : `${kl}s`, note: `New kind “${kl}”`, receipt });
    }
    if (kind === "") kind = null;
    otherId = opts.mint();
    ops.push({ op: "addNode", nodeId: otherId, type: o.type, kind, label, note: "Written on the profile", receipt });
  }
  const [fromId, toId] = f.direction === "out" ? [subjectId, otherId] : [otherId, subjectId];
  ops.push({ op: "addEdge", fromId, toId, relation: f.relation, status: "confirmed", confidence: 1, note: f.note?.slice(0, 300) ?? "Written on the profile", receipt });
  return { ops, otherId };
}
