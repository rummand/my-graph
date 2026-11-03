import type { Metadata } from "next";
import { z } from "zod";
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
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Library" lead="Letters, scans, photos, recordings and emails. Each file is kept exactly as you uploaded it, read for text, and linked to the people, places and events it mentions." />
      <LibraryView initial={initial} initialFilters={filters} />
    </div>
  );
}
