/**
 * Pure helpers for showing graphs: colour, grouping and the plain sentences that say who sees what.
 * No React, no DB, so the tests can cover them.
 */

export type GraphRole = "owner" | "editor" | "viewer";

export type GraphPerson = { userId: string; name: string; colorId: string; role: GraphRole };

/** A graph as the switcher and the Graphs page show it. */
export type GraphView = {
  id: string;
  name: string;
  description: string | null;
  kind: "family" | "personal" | "work" | "shared" | "other";
  color: number;
  myRole: GraphRole;
  memberCount: number;
  isFamily: boolean;
  isCurrent: boolean;
  ownerId: string | null;
  createdAt: string;
  members: GraphPerson[];
};

/** Hues a person can pick for a graph (oklch hue angles). Includes every default the backend hands out. */
export const GRAPH_PALETTE: { hue: number; name: string }[] = [
  { hue: 28, name: "Coral" },
  { hue: 62, name: "Apricot" },
  { hue: 130, name: "Moss" },
  { hue: 160, name: "Green" },
  { hue: 210, name: "Lake" },
  { hue: 265, name: "Blue" },
  { hue: 310, name: "Orchid" },
  { hue: 340, name: "Rose" },
];

/** CSS custom properties for a graph's colour: `--g` (the dot) and `--g-tint` (a pale wash that follows the theme). */
export function graphStyle(hue: number): Record<string, string> {
  const h = Number.isFinite(hue) ? ((Math.round(hue) % 360) + 360) % 360 : 210;
  return {
    "--g": `oklch(0.64 0.14 ${h})`,
    "--g-tint": `color-mix(in oklab, oklch(0.64 0.14 ${h}) 16%, var(--surface))`,
  };
}

export const KIND_LABEL: Record<GraphView["kind"], string> = {
  family: "Family", personal: "Just me", work: "Work", shared: "To share", other: "Something else",
};

export const ROLE_LABEL: Record<GraphRole, string> = {
  owner: "Owner", editor: "Can add and edit", viewer: "Can only look",
};

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

/** "Sara", "Sara and Mikkel", "Sara, Mikkel and Emma", "Sara and 3 others". */
export function joinNames(names: string[], max = 3): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length <= max) return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const rest = names.length - (max - 1);
  return `${names.slice(0, max - 1).join(", ")} and ${rest} others`;
}

export function others(g: Pick<GraphView, "members">, youId: string): GraphPerson[] {
  return g.members.filter((m) => m.userId !== youId);
}

export function ownerOf(g: Pick<GraphView, "members" | "ownerId">): GraphPerson | null {
  return g.members.find((m) => m.userId === g.ownerId) ?? g.members.find((m) => m.role === "owner") ?? null;
}

/** Mine: graphs I own, and my own family's graph. Shared with me: everything else. */
export function groupGraphs<T extends Pick<GraphView, "myRole" | "isFamily">>(graphs: T[]): { mine: T[]; shared: T[] } {
  const mine: T[] = [];
  const shared: T[] = [];
  for (const g of graphs) (g.isFamily || g.myRole === "owner" ? mine : shared).push(g);
  return { mine, shared };
}

/** The short line under a graph's name: who else is in it. Null when it is only you. */
export function sharingLine(g: Pick<GraphView, "members" | "ownerId" | "isFamily" | "myRole">, youId: string): string | null {
  const rest = others(g, youId).map((m) => firstName(m.name));
  if (g.isFamily) return rest.length ? `The family, ${rest.length + 1} people` : "The family";
  if (g.myRole !== "owner") {
    const owner = ownerOf(g);
    return owner ? `Shared by ${firstName(owner.name)}` : "Shared with you";
  }
  if (!rest.length) return null;
  return `Shared with ${joinNames(rest, 2)}`;
}

/** One plain sentence on what the people in this graph can and cannot see. */
export function whoSeesWhat(g: Pick<GraphView, "id" | "members" | "ownerId" | "isFamily" | "myRole">, all: Pick<GraphView, "id" | "name" | "myRole" | "isFamily">[], youId: string): string {
  const mineElsewhere = all.filter((x) => x.id !== g.id && (x.myRole === "owner" || x.isFamily)).map((x) => x.name);
  const elsewhere = mineElsewhere.length ? `Your ${joinNames(mineElsewhere, 4)} ${mineElsewhere.length === 1 ? "graph stays" : "graphs stay"} private.` : "";
  if (g.isFamily) {
    return "Everyone in the household works in this graph, and their private things stay their own. Graphs you share with other people never show up here.";
  }
  if (g.myRole !== "owner") {
    const owner = ownerOf(g);
    const who = owner ? firstName(owner.name) : "The owner";
    return `You see only what is in this graph. ${who}'s other graphs stay private, and nothing from your own graphs is shared with ${owner ? who : "them"}.`;
  }
  const rest = others(g, youId).map((m) => firstName(m.name));
  if (!rest.length) {
    return `Only you can see this graph. When you share it, people see what is in it and nothing else. ${elsewhere}`.trim();
  }
  const verb = rest.length === 1 ? "sees" : "see";
  return `${joinNames(rest, 3)} ${verb} only what is in this graph. ${elsewhere}`.trim();
}
