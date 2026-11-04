/**
 * Graph access rules, pure (no DB, no Next) so every module and the tests share one definition.
 *
 * A person works in one graph at a time (the "current graph"). Everything they read or write is scoped to it, and
 * only while they are a member. Within a graph the usual visibility rules apply, interpreted for that graph:
 *  - In their household's family graph the rules are exactly the family rules: household role decides
 *    (parents see "parents" items, children never see others' sensitive items, guests only see what is shared).
 *  - In any other graph the graph role decides: "household" = every member, "parents" = the owner and editors,
 *    private = only whoever added it. Viewers read but never write.
 * `scopeOf(viewer)` turns a viewer into that effective scope: `householdId` becomes the graph's household (the
 * owner's) and `role` the role the visibility rules should use, so the existing per-module rules keep working.
 */

export type Role = "owner" | "parent" | "child" | "guest";
export type GraphKind = "family" | "personal" | "work" | "shared" | "other" | "partner" | "project";
export type GraphRole = "owner" | "editor" | "viewer";

export const GRAPH_KINDS: GraphKind[] = ["family", "personal", "work", "shared", "other"];
export const GRAPH_ROLES: GraphRole[] = ["owner", "editor", "viewer"];
export const GRAPH_COOKIE = "mg_graph";

/** The graph a viewer is working in. Carried on every Viewer. */
export type GraphContext = {
  graphId: string;
  graphName: string;
  graphKind: GraphKind;
  graphRole: GraphRole;
  /** The graph owner's household; its meta model is the graph's ontology. */
  graphHouseholdId: string;
  graphOwnerId: string | null;
};

type BareInput = { id: string; householdId: string; role: Role } & Partial<GraphContext>;
/** A Viewer, a bare {id, householdId, role} (tests), or an already-computed Scope. */
export type ScopeInput = BareInput | Scope;

/** What the visibility rules see: who, in which graph, with which effective role. */
export type Scope = {
  id: string;
  /** The graph's household (content rows carry it). */
  householdId: string;
  /** Role the visibility rules use inside this graph. */
  role: Role;
  /** null only for bare test fixtures that carry no graph. */
  graphId: string | null;
  /** Family rules apply (the viewer's own household's family graph). */
  family: boolean;
  canWrite: boolean;
  graphRole: GraphRole;
};

/** The graph role a household member gets in their family graph. */
export function familyGraphRole(role: Role): GraphRole {
  return role === "owner" ? "owner" : role === "parent" ? "editor" : "viewer";
}

/** Family rules apply only in the viewer's own household's family graph. */
export function usesFamilyRules(homeHouseholdId: string, g: Pick<GraphContext, "graphKind" | "graphHouseholdId">): boolean {
  return g.graphKind === "family" && g.graphHouseholdId === homeHouseholdId;
}

/** Role for the visibility rules outside the family graph: owner → owner, editor → parent, viewer → child. */
export function roleForGraphRole(r: GraphRole): Role {
  return r === "owner" ? "owner" : r === "editor" ? "parent" : "child";
}

function isScope(v: ScopeInput): v is Scope {
  return "family" in v && "canWrite" in v;
}

export function scopeOf(v: ScopeInput): Scope {
  if (isScope(v)) return v;
  if (!v.graphId || !v.graphHouseholdId || !v.graphKind || !v.graphRole) {
    // A bare {id, householdId, role}: family rules without a graph filter (unit-test fixtures only).
    return { id: v.id, householdId: v.householdId, role: v.role, graphId: v.graphId ?? null, family: true,
      canWrite: v.role !== "guest", graphRole: familyGraphRole(v.role) };
  }
  const family = usesFamilyRules(v.householdId, { graphKind: v.graphKind, graphHouseholdId: v.graphHouseholdId });
  if (family) {
    return { id: v.id, householdId: v.graphHouseholdId, role: v.role, graphId: v.graphId, family: true,
      canWrite: v.role !== "guest", graphRole: v.graphRole };
  }
  return { id: v.id, householdId: v.graphHouseholdId, role: roleForGraphRole(v.graphRole), graphId: v.graphId, family: false,
    canWrite: v.graphRole !== "viewer", graphRole: v.graphRole };
}

/** True when an item from graph `itemGraphId` may be considered at all by this scope. */
export function sameGraph(s: Pick<Scope, "graphId">, itemGraphId: string | null | undefined): boolean {
  if (s.graphId === null) return true; // bare fixture
  return !!itemGraphId && itemGraphId === s.graphId;
}

/** Cross-graph references are forbidden: every id a write connects must be in the writer's graph. */
export function assertSameGraph(graphIds: (string | null | undefined)[]): boolean {
  const set = new Set(graphIds);
  return set.size === 1 && !set.has(null) && !set.has(undefined);
}

/* ── Managing graphs ─────────────────────────────────────────────────────────────────────────────────── */

export type GraphRow = { id: string; householdId: string; ownerId: string | null; kind: GraphKind; archivedAt: Date | null };

/** Only the graph's owner renames, archives, invites and manages members. */
export function canManageGraph(userId: string, myRole: GraphRole | null): boolean {
  return !!userId && myRole === "owner";
}

/** Why a graph can't be archived, or null when it can. */
export function archiveProblem(g: Pick<GraphRow, "kind" | "archivedAt">, remainingOwned: number): string | null {
  if (g.archivedAt) return "This graph is already archived.";
  if (g.kind === "family") return "The family graph can't be archived. It is where the whole household's things live.";
  if (remainingOwned <= 1) return "This is your last graph. Make another one before you archive it.";
  return null;
}

/** Why a member change is not allowed, or null. `actor` changes `target`. */
export function memberChangeProblem(p: {
  actorId: string; actorRole: GraphRole | null; targetId: string; targetRole: GraphRole | null;
  action: "remove" | "role"; newRole?: GraphRole; graphKind: GraphKind;
}): string | null {
  if (!p.targetRole) return "That person isn't in this graph.";
  const self = p.actorId === p.targetId;
  if (p.action === "remove") {
    if (self) {
      if (p.actorRole === "owner") return "You own this graph, so you can't leave it. Archive it instead.";
      if (p.graphKind === "family") return "Everyone in the household is in the family graph.";
      return null; // leaving
    }
    if (p.actorRole !== "owner") return "Only the graph's owner can remove people.";
    if (p.graphKind === "family") return "People in the household are managed in Family settings.";
    return null;
  }
  if (p.actorRole !== "owner") return "Only the graph's owner can change what people may do.";
  if (self) return "You can't change your own role.";
  if (p.graphKind === "family") return "Roles in the family graph follow Family settings.";
  if (p.newRole === "owner") return "A graph has one owner.";
  return null;
}

/** Whether an invite link is still usable. */
export function inviteState(i: { expiresAt: Date; acceptedAt: Date | null; revokedAt: Date | null }, now = new Date()):
  "open" | "accepted" | "revoked" | "expired" {
  if (i.revokedAt) return "revoked";
  if (i.acceptedAt) return "accepted";
  if (i.expiresAt.getTime() <= now.getTime()) return "expired";
  return "open";
}

/**
 * The graph to work in: the requested one if the person is a member, else their family graph, else a graph someone
 * shared with them (people who joined through an invite should land in what was made for them, not in their own
 * empty Personal graph), else their first.
 */
export function pickGraph<T extends { id: string; kind: GraphKind; householdId: string; archivedAt: Date | null }>(
  graphs: T[], homeHouseholdId: string, requested: string | null | undefined,
): T | null {
  const live = graphs.filter((g) => !g.archivedAt);
  if (requested) {
    const hit = live.find((g) => g.id === requested);
    if (hit) return hit;
  }
  return live.find((g) => g.kind === "family" && g.householdId === homeHouseholdId)
    ?? live.find((g) => g.householdId !== homeHouseholdId)
    ?? live[0] ?? null;
}

export const DEFAULT_HUES: Record<GraphKind, number> = { family: 28, personal: 265, work: 210, shared: 340, other: 160, partner: 330, project: 190 };

/* ── Members as people ───────────────────────────────────────────────────────────────────────────────── */

/**
 * Every member of a graph is a person in it: their "self" node. It is a person node owned by the member and marked
 * in props with `{ userId, self: true }` (no schema column). In the member's own household's family graph the self
 * node is the existing `users.personNodeId` node (stamped with the same marker). Self nodes never leave their graph.
 */
export const SELF_PROP = "self";
export const SELF_USER_PROP = "userId";

/** Props keys only the system writes on person nodes (stripped from anything people send in). */
export const RESERVED_PERSON_PROPS = [SELF_PROP, SELF_USER_PROP, "householdMember"] as const;

export function selfProps(userId: string): Record<string, unknown> {
  return { [SELF_USER_PROP]: userId, [SELF_PROP]: true };
}

/** The user a self node stands for, or null when the props are not a self marker. */
export function selfUserOf(props: Record<string, unknown> | null | undefined): string | null {
  if (!props || props[SELF_PROP] !== true) return null;
  const u = props[SELF_USER_PROP];
  return typeof u === "string" && u ? u : null;
}

/** True when `props` mark the self node of `userId`. */
export function isSelfOf(props: Record<string, unknown> | null | undefined, userId: string): boolean {
  return selfUserOf(props) === userId;
}

/** Props without the system-only keys (people can never claim to be someone's self node). */
export function stripReservedProps<T extends Record<string, unknown>>(props: T): T {
  const out = { ...props };
  for (const k of RESERVED_PERSON_PROPS) delete (out as Record<string, unknown>)[k];
  return out;
}

/**
 * Who sees a member's self node. Outside the family graph: every member ("household" means the graph's members).
 * In the family graph the household rules apply: guests stay private to themselves.
 */
export function selfVisibility(role: Role, family: boolean): "household" | "private" {
  return family && role === "guest" ? "private" : "household";
}

/** Kind of a self node: children are "child" in their own family graph; otherwise none (they are "you"). */
export function selfKind(role: Role, family: boolean): string | null {
  return family && role === "child" ? "child" : null;
}

export type SelfCandidate = { id: string; label: string; props: Record<string, unknown>; mergedInto: string | null; ownerId: string; createdAt: Date };

/**
 * Which of the candidate rows is the member's self node: their family node when it is here and live, else the
 * oldest live node marked as theirs, else (when `adoptName` is given) the oldest unmarked person node they own with
 * their name, which is how people wrote themselves in before self nodes existed. Used by ./self.
 */
export function pickSelfNode(rows: SelfCandidate[], userId: string, homeNodeId: string | null | undefined, adoptName?: string): SelfCandidate | null {
  const live = rows.filter((r) => !r.mergedInto).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const home = homeNodeId ? live.find((r) => r.id === homeNodeId) : undefined;
  if (home) return home;
  const marked = live.find((r) => r.ownerId === userId && isSelfOf(r.props, userId));
  if (marked) return marked;
  if (!adoptName) return null;
  const name = adoptName.trim().toLowerCase();
  return live.find((r) => r.ownerId === userId && r.props.self === undefined
    && r.label.trim().toLowerCase() === name) ?? null;
}
