import type { Metadata } from "next";
import { z } from "zod";
import { GraphWelcome } from "@/components/graphs/graph-welcome";
import { PageHeader } from "@/components/ui";
import { LibraryView, type LibraryFilters } from "@/components/library/library-view";
import { requireUser } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { LIBRARY_TYPES, listSources, type LibraryType } from "@/lib/ingest/library";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("library.metaTitle") };
}
export const dynamic = "force-dynamic";

const params = z.object({
  type: z.enum(LIBRARY_TYPES as [LibraryType, ...LibraryType[]]).optional().catch(undefined),
  status: z.enum(["pending", "processing", "ready", "failed"]).optional().catch(undefined),
  q: z.string().max(200).optional().catch(undefined),
});

export default async function LibraryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const v = await requireUser();
  const t = await getT();
  const family = v.graphKind === "family";
  const raw = await searchParams;
  const f = params.parse({ type: raw.type, status: raw.status, q: typeof raw.q === "string" ? raw.q : undefined });
  const initial = await listSources(v, { category: f.type, status: f.status, q: f.q });
  const filters: LibraryFilters = { type: f.type ?? "", status: f.status ?? "", q: f.q ?? "" };
  return (
    <div>
      <PageHeader title={t("library.title")} lead={t(family ? "library.lead.family" : "library.lead.graph")} />
      <GraphWelcome viewer={v} />
      <LibraryView initial={initial} initialFilters={filters} family={family} />
    </div>
  );
}
