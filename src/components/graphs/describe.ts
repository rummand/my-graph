/**
 * Pure helpers for showing graphs: colour, grouping and the plain sentences that say who sees what.
 * No React, no DB, so the tests can cover them. Every sentence takes the reader's translator (`t`); without one it is
 * English, from the same message file.
 */
import { makeT, type TFn } from "@/lib/i18n/core";
import enGraphs from "@/lib/i18n/messages/en/graphs";

const EN: TFn = makeT("en", { graphs: enGraphs });

export type GraphRole = "owner" | "editor" | "viewer";

export type GraphPerson = { userId: string; name: string; colorId: string; role: GraphRole };

/** A graph as the switcher and the Graphs page show it. */
export type GraphView = {
  id: string;
  name: string;
  description: string | null;
  kind: "family" | "personal" | "work" | "shared" | "other" | "partner" | "project" | "practice";
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
  family: "Family", personal: "Just me", work: "Work", shared: "To share", other: "Something else", partner: "For a partner", project: "A project", practice: "Practice",
};

export const ROLE_LABEL: Record<GraphRole, string> = {
  owner: "Owner", editor: "Can add and edit", viewer: "Can only look",
};

export const kindLabel = (kind: GraphView["kind"], t: TFn = EN) => t(`graphs.kinds.${kind}`, undefined, KIND_LABEL[kind]);
export const roleLabel = (role: GraphRole, t: TFn = EN) => t(`graphs.roles.${role}`, undefined, ROLE_LABEL[role]);

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

/** "Sara", "Sara and Mikkel", "Sara, Mikkel and Emma", "Sara and 3 others". */
export function joinNames(names: string[], max = 3, t: TFn = EN): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2 && max >= 2) return t("graphs.list.two", { a: names[0], b: names[1] });
  if (names.length <= max) return t("graphs.list.many", { list: names.slice(0, -1).join(", "), last: names[names.length - 1] });
  const rest = names.length - (max - 1);
  return t("graphs.list.andOthers", { list: names.slice(0, max - 1).join(", "), count: rest });
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
export function sharingLine(g: Pick<GraphView, "members" | "ownerId" | "isFamily" | "myRole">, youId: string, t: TFn = EN): string | null {
  const rest = others(g, youId).map((m) => firstName(m.name));
  if (g.isFamily) return rest.length ? t("graphs.sharing.familyWith", { count: rest.length + 1 }) : t("graphs.sharing.family");
  if (g.myRole !== "owner") {
    const owner = ownerOf(g);
    return owner ? t("graphs.sharing.sharedBy", { name: firstName(owner.name) }) : t("graphs.sharing.sharedWithYou");
  }
  if (!rest.length) return null;
  return t("graphs.sharing.sharedWith", { names: joinNames(rest, 2, t) });
}

/** One plain sentence on what the people in this graph can and cannot see. */
export function whoSeesWhat(g: Pick<GraphView, "id" | "members" | "ownerId" | "isFamily" | "myRole">, all: Pick<GraphView, "id" | "name" | "myRole" | "isFamily">[], youId: string, t: TFn = EN): string {
  const mineElsewhere = all.filter((x) => x.id !== g.id && (x.myRole === "owner" || x.isFamily)).map((x) => x.name);
  const elsewhere = mineElsewhere.length ? t("graphs.sees.elsewhere", { names: joinNames(mineElsewhere, 4, t), count: mineElsewhere.length }) : "";
  if (g.isFamily) return t("graphs.sees.family");
  if (g.myRole !== "owner") {
    const owner = ownerOf(g);
    return owner ? t("graphs.sees.sharedOwner", { owner: firstName(owner.name) }) : t("graphs.sees.sharedNoOwner");
  }
  const rest = others(g, youId).map((m) => firstName(m.name));
  if (!rest.length) return `${t("graphs.sees.onlyYou")} ${elsewhere}`.trim();
  return `${t("graphs.sees.others", { names: joinNames(rest, 3, t), count: rest.length })} ${elsewhere}`.trim();
}
