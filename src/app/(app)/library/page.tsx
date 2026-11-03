import type { Metadata } from "next";
import { z } from "zod";
import { GraphWelcome } from "@/components/graphs/graph-welcome";
import { PageHeader } from "@/components/ui";
import { LibraryView, type LibraryFilters } from "@/components/library/library-view";
import { requireUser } from "@/lib/auth";
import { listSources } from "@/lib/ingest/library";

export const metadata: Metadata = { title: "Library · My Graph" };
export const dynamic = "force-dynamic";

const params = z.object({
  type: z.enum(["pdf", "document", "text", "image", "audio", "email", "other"]).optional().catch(undefined),
  status: z.enum(["pending", "processing", "ready", "failed"]).optional().catch(undefined),
  q: z.string().max(200).optional().catch(undefined),
});

export default async function LibraryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const v = await requireUser();
  const raw = await searchParams;
  const f = params.parse({ type: raw.type, status: raw.status, q: typeof raw.q === "string" ? raw.q : undefined });
  const initial = await listSources(v, { category: f.type, status: f.status, q: f.q });
  const filters: LibraryFilters = { type: f.type ?? "", status: f.status ?? "", q: f.q ?? "" };
  return (
    <div>
      <PageHeader title="Library" lead="Every letter, scan, photo and recording the family has added, each one read for the people and dates in it." />
      <GraphWelcome viewer={v} />
      <LibraryView initial={initial} initialFilters={filters} />
    </div>
  );
}
