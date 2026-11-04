import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { format, isToday } from "date-fns";
import { clsx } from "clsx";
import { ArrowLeft, Sparkles } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/ui";
import { DiffView } from "@/components/wiki/diff-view";
import { RestoreButton } from "@/components/wiki/restore-button";
import { fullWhen, sentenceWhen, shortWhen } from "@/components/wiki/when";
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
    <div>
      <Link href={pageHref} className="-ml-2 mb-3 inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-fg">
        <ArrowLeft aria-hidden className="size-4" /><span className="max-w-[40ch] truncate">{page.title}</span>
      </Link>
      <PageHeader title="Version history"
        lead={<>Every saved version of <span className="text-fg">{page.title}</span>, newest first. Edits made close together by one person count as one version. Versions the assistant wrote show who asked for them. Restoring an old version adds it on top, so nothing is lost.</>} />

      {!selected ? (
        <EmptyState title="No versions yet"><p>Versions appear here once the page has been saved.</p></EmptyState>
      ) : (
        <div className="grid gap-x-10 gap-y-8 lg:grid-cols-[17rem_minmax(0,1fr)]">
          <nav aria-label="Versions" className="order-2 lg:order-1">
            <h2 className="mb-2 text-sm font-semibold text-muted lg:sr-only">All versions</h2>
            <ol className="-mx-1 space-y-0.5">
              {revisions.map((r, i) => {
                const prev = revisions[i + 1];
                const stats = diffStats(wordDiff(prev?.contentText ?? "", r.contentText ?? ""));
                const active = i === selectedIdx;
                return (
                  <li key={r.id}>
                    <Link href={`?rev=${r.id}`} aria-current={active ? "true" : undefined} scroll={false}
                      className={clsx("block rounded-lg px-3 py-2.5 transition-colors duration-150",
                        r.authorKind === "assistant" && "shadow-[inset_2px_0_0_var(--accent)]",
                        active ? "bg-surface" : "hover:bg-surface-2")}>
                      <span className="flex items-baseline justify-between gap-3">
                        {r.authorKind === "assistant" ? <AssistantAuthor name={r.authorName} /> : (
                          <span className="flex min-w-0 items-center gap-1.5 font-medium"><span className="truncate">{r.authorName}</span></span>
                        )}
                        <time dateTime={r.createdAt.toISOString()} title={fullWhen(r.createdAt)} className="shrink-0 text-sm tabular-nums text-muted">{listWhen(r.createdAt)}</time>
                      </span>
                      <span className="mt-0.5 block text-sm text-muted">
                        {i === 0 && <span className="font-medium text-fg">Current. </span>}
                        {r.summary ?? (prev ? <ChangeCount added={stats.added} removed={stats.removed} /> : "First version")}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ol>
          </nav>

          <section aria-labelledby="rev-heading" className="order-1 min-w-0 rounded-lg bg-surface px-5 pb-12 pt-7 sm:px-10 lg:order-2 lg:px-12">
            <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <h2 id="rev-heading" className="text-lg font-semibold tracking-[-0.01em]">
                  {selectedIdx === 0 ? `Version ${selected.version}, the current one` : `Version ${selected.version}`}
                </h2>
                <p className="mt-1 text-sm text-muted">
                  {selected.authorKind === "assistant"
                    ? <>The assistant wrote it{askedBy(selected.authorName) ? `, asked by ${askedBy(selected.authorName)}` : ""}, {sentenceWhen(selected.createdAt)}{selected.summary ? <>. {selected.summary}</> : null}.{" "}</>
                    : <>{selected.authorName} saved it {sentenceWhen(selected.createdAt)}.{" "}</>}
                  {previous ? <>Compared with version {previous.version}.</> : <>This is the first version.</>}
                </p>
              </div>
              {selectedIdx > 0 && page.can.edit && (
                <RestoreButton key={selected.id} slug={page.slug} revisionId={selected.id} revisionVersion={selected.version} pageVersion={page.version} />
              )}
            </div>
            <DiffView before={previous?.contentText ?? ""} after={selected.contentText ?? ""} beforeTitle={previous?.title} afterTitle={selected.title} />
          </section>
        </div>
      )}
    </div>
  );
}

/** "Assistant (asked by Anna)" → "Anna". */
function askedBy(authorName: string): string | null {
  return /\(asked by (.+)\)$/.exec(authorName)?.[1] ?? null;
}

function AssistantAuthor({ name }: { name: string }) {
  const who = askedBy(name);
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Sparkles aria-hidden className="size-3.5 shrink-0 self-center text-accent" />
      <span className="shrink-0 font-medium">Assistant</span>
      {who && <span className="truncate text-sm text-muted">asked by {who}</span>}
    </span>
  );
}

function ChangeCount({ added, removed }: { added: number; removed: number }) {
  if (added === 0 && removed === 0) return <>No text changes</>;
  return (
    <>
      {added > 0 && <span className="text-accent">{added} {added === 1 ? "word" : "words"} added</span>}
      {added > 0 && removed > 0 && ", "}
      {removed > 0 && <span className="text-danger">{removed}{added > 0 ? "" : removed === 1 ? " word" : " words"} removed</span>}
    </>
  );
}

function listWhen(d: Date): string {
  return isToday(d) ? format(d, "HH:mm") : `${shortWhen(d)}, ${format(d, "HH:mm")}`;
}
