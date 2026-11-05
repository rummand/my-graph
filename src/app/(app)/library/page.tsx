import type { Metadata } from "next";
import { z } from "zod";
import { GraphWelcome } from "@/components/graphs/graph-welcome";
import { PageHeader } from "@/components/ui";
import { LibraryView, type LibraryFilters } from "@/components/library/library-view";
import { requireUser } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { LIBRARY_TYPES, listSources, type LibraryType } from "@/lib/ingest/library";
import { listFolders } from "@/lib/ingest/folders";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("library.metaTitle") };
}
export const dynamic = "force-dynamic";

const params = z.object({
  type: z.enum(LIBRARY_TYPES as [LibraryType, ...LibraryType[]]).optional().catch(undefined),
  status: z.enum(["pending", "processing", "ready", "failed"]).optional().catch(undefined),
  q: z.string().max(200).optional().catch(undefined),
  folder: z.union([z.literal("root"), z.string().uuid()]).optional().catch(undefined),
});

export default async function LibraryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const v = await requireUser();
  const t = await getT();
  const family = v.graphKind === "family";
  const raw = await searchParams;
  const f = params.parse({ type: raw.type, status: raw.status, q: typeof raw.q === "string" ? raw.q : undefined, folder: raw.folder });
  const folders = await listFolders(v);
  // A folder that isn't there (deleted, not shared with you): everything instead.
  const known = (id: string, fs: typeof folders.folders): boolean => fs.some((x) => x.id === id || known(id, x.children));
  const folder = f.folder === "root" || (f.folder && known(f.folder, folders.folders)) ? f.folder : undefined;
  const initial = await listSources(v, { category: f.type, status: f.status, q: f.q, folder });
  const filters: LibraryFilters = { type: f.type ?? "", status: f.status ?? "", q: f.q ?? "", folder: folder ?? "" };
  return (
    <div>
      <PageHeader title={t("library.title")} lead={t(family ? "library.lead.family" : "library.lead.graph")} />
      <GraphWelcome viewer={v} />
      <LibraryView initial={initial} initialFilters={filters} initialFolders={folders} family={family} graphKind={v.graphKind} />
    </div>
  );
}
