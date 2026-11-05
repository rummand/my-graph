/**
 * Turning kinds that are really roles into roles (pure). Before roles existed, a person got one kind: "doctor",
 * "teacher", "colleague". Those are roles: someone can hold several, somewhere, for a time. This plans the proposal
 * (never a silent edit) that, per person the viewer may change:
 *
 *  - adds the role as a fact: `person —role:<kind>→ context`, the context read from what the graph already says
 *    (a doctor who treats Emma is "doctor of Emma", a teacher_of edge gives "teacher of Emma", member_of an
 *    organisation gives "… at Acme"), else the role without a context;
 *  - skips the role where a relation already says it (a grandparent with grandparent_of: the relation is the role);
 *  - clears the kind (only kinds that became roles; "child", "partner" and clinical record kinds stay);
 *  - and for "people" that are only a role ("the teacher", "Lægen", "Speaker 2"): merges them into the one person who
 *    holds that role when there is exactly one, else proposes retiring them (nothing is deleted; retiring is undoable).
 */
import type { ChangeInput } from "@/lib/changes";
import { roleKeyForKind, roleMention, roleRelation, roleKeyOf } from "./roles";

export type ConvNode = { id: string; type: string; kind: string | null; label: string; props?: Record<string, unknown> | null };
export type ConvEdge = { id: string; fromId: string; toId: string; relation: string; status: string };

export type ConversionInput = {
  nodes: ConvNode[];
  edges: ConvEdge[];
  /** Keys of the roles this graph knows. */
  roleKeys: ReadonlySet<string>;
  /** Role key → the relation that already says it ("grandparent_of:out"). */
  impliedBy: ReadonlyMap<string, string>;
  /** May the person proposing change this node? (Others' private people are left to them.) */
  editable?: (id: string) => boolean;
};

export type ConversionItem =
  | { kind: "role"; personId: string; person: string; role: string; contexts: string[]; implied: boolean }
  | { kind: "merge"; personId: string; person: string; role: string | null; into: { id: string; label: string } }
  | { kind: "retire"; personId: string; person: string; role: string | null };

export type ConversionPlan = {
  changes: ChangeInput[];
  items: ConversionItem[];
  counts: { people: number; roles: number; withContext: number; implied: number; merged: number; retired: number };
};

const word = (k: string | null) => (k ?? "").replace(/_/g, " ");
const DEAD = new Set(["rejected", "superseded"]);

/** Which edges give a role its context: relation, and which end of it the context is (seen from the role holder). */
const CONTEXT_FROM: Record<string, { relation: string; dir: "out" | "in" }[]> = {
  doctor: [{ relation: "treated_by", dir: "in" }],
  dentist: [{ relation: "treated_by", dir: "in" }],
  nurse: [{ relation: "treated_by", dir: "in" }],
  health_visitor: [{ relation: "treated_by", dir: "in" }],
  psychologist: [{ relation: "treated_by", dir: "in" }],
  teacher: [{ relation: "teacher_of", dir: "out" }],
  class_teacher: [{ relation: "teacher_of", dir: "out" }],
  pedagogue: [{ relation: "teacher_of", dir: "out" }],
  coach: [{ relation: "coaches", dir: "out" }],
  colleague: [{ relation: "works_with", dir: "out" }],
  client: [{ relation: "client_of", dir: "out" }],
  babysitter: [{ relation: "babysits", dir: "out" }],
};
/** Any role: where they are or belong (a doctor located at the clinic, a colleague member of the company). */
const PLACE_RELATIONS = new Set(["located_at", "member_of", "works_at", "works_for", "employed_by"]);

const MAX_CONTEXTS = 3;
const CONTEXT_TYPES = new Set(["person", "organization", "place", "project", "thing"]);

export function planRoleConversion(input: ConversionInput): ConversionPlan {
  const changes: ChangeInput[] = [];
  const items: ConversionItem[] = [];
  const counts = { people: 0, roles: 0, withContext: 0, implied: 0, merged: 0, retired: 0 };
  const byId = new Map(input.nodes.map((n) => [n.id, n]));
  const live = input.edges.filter((e) => !DEAD.has(e.status) && byId.has(e.fromId) && byId.has(e.toId));
  const editable = input.editable ?? (() => true);
  const persons = input.nodes.filter((n) => n.type === "person" && n.props?.retired !== true);
  const isMember = (n: ConvNode) => n.props?.self === true || n.props?.householdMember === true || typeof n.props?.userId === "string";

  // Who holds which role (by role edge, or by a kind that is that role), for merging role-only mentions.
  const holders = new Map<string, Set<string>>();
  const hold = (role: string, id: string) => (holders.get(role) ?? holders.set(role, new Set()).get(role)!).add(id);
  for (const e of live) { const k = roleKeyOf(e.relation); if (k) hold(k, e.fromId); }
  for (const p of persons) { const k = roleKeyForKind(p.kind, input.roleKeys); if (k) hold(k, p.id); }

  const mentions = new Map<string, ReturnType<typeof roleMention>>();
  for (const p of persons) {
    if (isMember(p)) continue;
    const m = roleMention(p.label);
    if (m) mentions.set(p.id, m);
  }

  // 1. Kinds that are roles.
  for (const p of persons) {
    if (mentions.has(p.id) || !editable(p.id)) continue;
    const role = roleKeyForKind(p.kind, input.roleKeys);
    if (!role) continue;
    counts.people++;
    const mine = live.filter((e) => e.fromId === p.id || e.toId === p.id);
    const relation = roleRelation(role);
    const already = new Set(mine.filter((e) => e.relation === relation && e.fromId === p.id).map((e) => e.toId));
    const implied = impliedHere(input.impliedBy.get(role), p.id, mine);
    const contexts: string[] = [];
    if (!implied && already.size === 0) {
      for (const c of CONTEXT_FROM[role] ?? []) {
        for (const e of mine) {
          if (e.relation !== c.relation) continue;
          const other = c.dir === "out" ? (e.fromId === p.id ? e.toId : null) : (e.toId === p.id ? e.fromId : null);
          // A role is held for someone or somewhere, never for an event or a document ("Dentist appointment … treated by").
          if (other && other !== p.id && !contexts.includes(other) && CONTEXT_TYPES.has(byId.get(other)?.type ?? "")) contexts.push(other);
        }
      }
      for (const e of mine) {
        if (e.fromId !== p.id || !PLACE_RELATIONS.has(e.relation)) continue;
        const to = byId.get(e.toId);
        if (to && (to.type === "place" || to.type === "organization" || to.type === "project") && !contexts.includes(to.id)) contexts.push(to.id);
      }
      const targets = contexts.slice(0, MAX_CONTEXTS);
      for (const ctx of targets.length ? targets : [p.id]) {
        const ctxNode = byId.get(ctx)!;
        changes.push({
          op: "addEdge", fromId: p.id, toId: ctx, relation, status: "confirmed", confidence: 1,
          note: ctx === p.id
            ? `${p.label} had the kind “${word(p.kind)}”, which is a role. Where they hold it isn't known yet.`
            : `${p.label} had the kind “${word(p.kind)}”, which is a role; the graph says it is held for ${ctxNode.label}.`,
          receipt: { quote: `${p.label}: ${word(p.kind)}`, confidence: 1 },
        });
        counts.roles++;
        if (ctx !== p.id) counts.withContext++;
      }
    } else if (implied) counts.implied++;
    changes.push({
      op: "updateNode", nodeId: p.id, set: { kind: null },
      note: implied
        ? `A relation already says ${p.label} is a ${role.replace(/_/g, " ")}; the kind isn't needed.`
        : `“${word(p.kind)}” is now a role ${p.label} holds, not what kind of person they are.`,
    });
    items.push({ kind: "role", personId: p.id, person: p.label, role, contexts: contexts.slice(0, MAX_CONTEXTS).map((c) => byId.get(c)!.label), implied });
  }

  // 2. "People" that are only a role.
  for (const [id, m] of mentions) {
    if (!m || !editable(id)) continue;
    const p = byId.get(id)!;
    const candidates = m.role ? [...(holders.get(m.role) ?? [])].filter((x) => x !== id && !mentions.has(x)) : [];
    const into = candidates.length === 1 ? byId.get(candidates[0]) : undefined;
    if (into) {
      changes.push({ op: "mergeNodes", keepId: into.id, dropId: id, note: `“${p.label}” names a role, not a person; ${into.label} is the only ${m.role!.replace(/_/g, " ")} here.` });
      items.push({ kind: "merge", personId: id, person: p.label, role: m.role, into: { id: into.id, label: into.label } });
      counts.merged++;
    } else {
      changes.push({ op: "retireNode", nodeId: id, note: m.role
        ? `“${p.label}” names a role (${m.role.replace(/_/g, " ")}), not a person. Nobody is deleted: it can be brought back.`
        : `“${p.label}” is a placeholder for someone unnamed, not a person. Nobody is deleted: it can be brought back.` });
      items.push({ kind: "retire", personId: id, person: p.label, role: m.role });
      counts.retired++;
    }
  }
  return { changes, items, counts };
}

/** Does a relation already say this role for this person ("grandparent_of:out" and they are a grandparent of someone)? */
function impliedHere(implied: string | undefined, personId: string, edges: ConvEdge[]): boolean {
  if (!implied) return false;
  const [rel, dir] = implied.split(":");
  return edges.some((e) => e.relation === rel && (dir === "out" ? e.fromId === personId : dir === "in" ? e.toId === personId : true));
}
