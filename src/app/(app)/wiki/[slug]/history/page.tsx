import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { format, formatDistanceToNow } from "date-fns";
import { clsx } from "clsx";
import { Bot } from "lucide-react";
import { EmptyState } from "@/components/ui";
import { DiffView } from "@/components/wiki/diff-view";
import { RestoreButton } from "@/components/wiki/restore-button";
import { requireUser } from "@/lib/auth";
import { diffStats, wordDiff } from "@/lib/wiki/diff";
import { getPage, listRevisions } from "@/lib/wiki";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const SLUG = /^[a-z0-9-]{1,120}$/;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  if (!SLUG.test(slug)) return { title: "Not found · My Graph" };
  const v = await requireUser();
  const page = await getPage(v, slug);
  return { title: page ? `History of ${page.title} · My Graph` : "Not found · My Graph" };
}

export default async function WikiHistory({ params, searchParams }: Props) {
  const { slug } = await params;
  if (!SLUG.test(slug)) notFound();
  const v = await requireUser();
  const page = await getPage(v, slug);
  if (!page) notFound();
  const revisions = await listRevisions(v, slug, { withText: true, limit: 200 });
  const sp = await searchParams;
  const selectedIdx = Math.max(0, revisions.findIndex((r) => r.id === sp.rev));
  const selected = revisions[selectedIdx];
  const previous = revisions[selectedIdx + 1];
  const pageHref = `/wiki/${encodeURIComponent(page.slug)}`;

  return (
    <div className="mx-auto max-w-6xl">
      <nav aria-label="Breadcrumb" className="mb-3 text-sm text-muted">
        <Link href="/wiki" className="hover:text-fg hover:underline">Wiki</Link><span aria-hidden> / </span>
        <Link href={pageHref} className="hover:text-fg hover:underline">{page.title}</Link><span aria-hidden> / </span>
        <span className="text-fg">History</span>
      </nav>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">History of “{page.title}”</h1>
        <p className="mt-1 max-w-prose text-sm text-muted">Every saved version, newest first. Edits made close together by the same person are grouped into one version. Restoring a version adds it as a new one, so nothing is lost.</p>
      </header>

      {!selected ? (
        <EmptyState title="No history yet"><p>Versions appear here once the page is saved.</p></EmptyState>
      ) : (
        <div className="grid gap-8 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <nav aria-label="Versions">
            <ol className="space-y-1">
              {revisions.map((r, i) => {
                const prev = revisions[i + 1];
                const stats = diffStats(wordDiff(prev?.contentText ?? "", r.contentText ?? ""));
                const active = i === selectedIdx;
                return (
                  <li key={r.id}>
                    <Link href={`?rev=${r.id}`} aria-current={active ? "true" : undefined} scroll={false}
                      className={clsx("block rounded-md px-3 py-2 text-sm", active ? "bg-accent-tint" : "hover:bg-surface-2")}>
                      <span className="flex items-center justify-between gap-2">
                        <span className={clsx("flex min-w-0 items-center gap-1.5 font-medium", active && "text-accent")}>
                          {r.authorKind === "assistant" && <Bot aria-hidden className="size-4 shrink-0" />}
                          <span className="truncate">{r.authorName}</span>
                        </span>
                        <span className="shrink-0 text-xs text-muted">v{r.version}</span>
                      </span>
                      <span className="block text-xs text-muted">
                        <time dateTime={r.createdAt.toISOString()} title={format(r.createdAt, "PPpp")}>{formatDistanceToNow(r.createdAt, { addSuffix: true })}</time>
                        {i === 0 && " · current"}
                      </span>
                      <span className="block text-xs text-muted">
                        {r.summary ?? (prev ? `+${stats.added} / −${stats.removed} words` : "First version")}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ol>
          </nav>

          <section aria-labelledby="rev-heading" className="min-w-0">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 id="rev-heading" className="text-lg font-semibold">Version {selected.version}{selectedIdx === 0 ? " (current)" : ""}</h2>
                <p className="text-sm text-muted">
                  {selected.authorName} · {format(selected.createdAt, "PPpp")}
                  {previous ? <> · compared with version {previous.version}</> : <> · the first version</>}
                </p>
              </div>
              {selectedIdx > 0 && page.can.edit && (
                <RestoreButton slug={page.slug} revisionId={selected.id} revisionVersion={selected.version} pageVersion={page.version} />
              )}
            </div>
            <DiffView before={previous?.contentText ?? ""} after={selected.contentText ?? ""} beforeTitle={previous?.title} afterTitle={selected.title} />
          </section>
        </div>
      )}
      <p className="mt-8 text-sm"><Link href={pageHref} className="text-accent hover:underline">Back to the page</Link></p>
    </div>
  );
}
