/**
 * Everything made in the current graph as one list for the Artifacts hub: pages (src/lib/pages) and documents and
 * decks (artifacts). Each library reads as the viewer, so visibility and the graph scope stay theirs.
 */
import type { Viewer } from "@/lib/auth";
import { listPages } from "@/lib/pages";
import { listArtifacts } from "./index";
import { madeHref, madeKindOf, mergeMade, type MadeFilter, type MadeItem } from "./kinds";

export async function listMade(v: Viewer, f: MadeFilter = {}): Promise<MadeItem[]> {
  const wantPages = !f.kind || f.kind === "page";
  const wantArtifacts = !f.kind || f.kind === "document" || f.kind === "deck";
  const [pages, arts] = await Promise.all([
    wantPages ? listPages(v, { q: f.q || undefined, limit: 200 }).catch(() => []) : Promise.resolve([]),
    wantArtifacts ? listArtifacts(v).catch(() => []) : Promise.resolve([]),
  ]);
  const pageItems: MadeItem[] = pages.map((p) => ({
    kind: "page", subKind: null, id: p.id, title: p.title, href: madeHref({ kind: "page", id: p.id, slug: p.slug }),
    excerpt: p.excerpt || null, ownerName: p.ownerName, isMine: p.ownerId === v.id, status: null, drafting: false,
    updatedAt: p.updatedAt.toISOString(),
  }));
  const artItems: MadeItem[] = arts.map((a) => {
    const kind = madeKindOf(a.kind);
    return {
      kind, subKind: a.kind, id: a.id, title: a.title, href: madeHref({ kind, id: a.id }), excerpt: null,
      ownerName: a.ownerName, isMine: a.isMine, status: a.status, drafting: a.drafting, updatedAt: a.updatedAt,
    };
  });
  // Pages were already searched in their text on the server; keep them even when the excerpt misses the word.
  const q = f.q?.trim();
  const searchedPages = q ? mergeMade([pageItems], { ...f, q: null }) : null;
  return searchedPages ? mergeMade([searchedPages, mergeMade([artItems], f)], { ...f, q: null }) : mergeMade([pageItems, artItems], f);
}
