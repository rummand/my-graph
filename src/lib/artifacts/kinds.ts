/**
 * Everything people make in a graph, in one registry: pages (written by hand, with the assistant alongside),
 * documents (reports, one-pagers, briefs and profiles drafted from the graph), decks, and later images and diagrams.
 * The Artifacts hub, its New menu and kind filters, search and the assistant all read from here, so a new kind is
 * added once. Pure: no database, no React components (icons are lucide names, mapped where they are drawn).
 *
 * Storage stays where it is: pages live in `wiki_pages` (src/lib/pages), documents and decks in `artifacts`
 * (src/lib/artifacts). `kind` here is what a person sees, not a column.
 */
import { ARTIFACT_KINDS, type ArtifactKind } from "@/lib/design-sets/tokens";

export const MADE_KINDS = ["page", "document", "deck", "image", "diagram"] as const;
export type MadeKind = (typeof MADE_KINDS)[number];

/** Lucide icon names; `src/components/artifacts/kind-icon.tsx` draws them. */
export type MadeKindIcon = "FileText" | "ScrollText" | "Presentation" | "Image" | "Workflow";

export type MadeKindDef = {
  id: MadeKind;
  /** Message keys: one ("Page"), many ("Pages"), the New menu's hint. */
  label: string;
  plural: string;
  hint: string;
  icon: MadeKindIcon;
  /** The hub tab that lists this kind. */
  route: string;
  /** Where "New" starts one. */
  newHref: string;
  /** The `artifacts.kind` values this kind covers (documents and decks); pages have none. */
  artifactKinds: readonly ArtifactKind[];
  /** False until the kind can be made: hidden from the New menu, the tabs and the filters. */
  available: boolean;
};

const DOCUMENT_KINDS = ARTIFACT_KINDS.filter((k) => k !== "deck");

export const MADE: Record<MadeKind, MadeKindDef> = {
  page: {
    id: "page", label: "artifacts.made.page.one", plural: "artifacts.made.page.many", hint: "artifacts.made.page.hint", icon: "FileText",
    route: "/artifacts/pages", newHref: "/artifacts/pages/new", artifactKinds: [], available: true,
  },
  document: {
    id: "document", label: "artifacts.made.document.one", plural: "artifacts.made.document.many", hint: "artifacts.made.document.hint", icon: "ScrollText",
    route: "/artifacts/documents", newHref: "/artifacts/new", artifactKinds: DOCUMENT_KINDS, available: true,
  },
  deck: {
    id: "deck", label: "artifacts.made.deck.one", plural: "artifacts.made.deck.many", hint: "artifacts.made.deck.hint", icon: "Presentation",
    route: "/artifacts/decks", newHref: "/artifacts/new?kind=deck", artifactKinds: ["deck"], available: true,
  },
  image: {
    id: "image", label: "artifacts.made.image.one", plural: "artifacts.made.image.many", hint: "artifacts.made.image.hint", icon: "Image",
    route: "/artifacts/images", newHref: "/artifacts/images/new", artifactKinds: [], available: false,
  },
  diagram: {
    id: "diagram", label: "artifacts.made.diagram.one", plural: "artifacts.made.diagram.many", hint: "artifacts.made.diagram.hint", icon: "Workflow",
    route: "/artifacts/diagrams", newHref: "/artifacts/diagrams/new", artifactKinds: [], available: false,
  },
};

/** The kinds that can be made today, in menu order. */
export function availableKinds(): MadeKindDef[] {
  return MADE_KINDS.map((k) => MADE[k]).filter((k) => k.available);
}

/** Which made kind an `artifacts` row is (a deck is a deck; reports, one-pagers, briefs and profiles are documents). */
export function madeKindOf(artifactKind: string): MadeKind {
  return artifactKind === "deck" ? "deck" : "document";
}

export function isMadeKind(x: unknown): x is MadeKind {
  return typeof x === "string" && (MADE_KINDS as readonly string[]).includes(x);
}

/** Where one item opens. */
export function madeHref(item: { kind: MadeKind; id: string; slug?: string | null }): string {
  return item.kind === "page" ? `/artifacts/pages/${encodeURIComponent(item.slug ?? item.id)}` : `/artifacts/${item.id}`;
}

/** One row of the hub's All list: pages and artifacts side by side. */
export type MadeItem = {
  kind: MadeKind;
  /** The finer kind for documents ("report", "one_pager" …), null for pages. */
  subKind: ArtifactKind | null;
  id: string;
  title: string;
  href: string;
  excerpt: string | null;
  ownerName: string | null;
  isMine: boolean;
  /** Pages have no draft/published state (null). */
  status: "draft" | "published" | null;
  drafting: boolean;
  updatedAt: string;
};

export type MadeFilter = { kind?: MadeKind | null; q?: string | null; mine?: boolean };

/** Merge, filter and sort (newest first). Pure, so the hub and tests agree. */
export function mergeMade(lists: MadeItem[][], f: MadeFilter = {}): MadeItem[] {
  const q = f.q?.trim().toLowerCase() ?? "";
  return lists.flat()
    .filter((i) => MADE[i.kind].available)
    .filter((i) => !f.kind || i.kind === f.kind)
    .filter((i) => !f.mine || i.isMine)
    .filter((i) => !q || i.title.toLowerCase().includes(q) || (i.excerpt ?? "").toLowerCase().includes(q))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}
