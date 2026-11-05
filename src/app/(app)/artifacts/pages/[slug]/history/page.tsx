import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { clsx } from "clsx";
import { ArrowLeft, Sparkles } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/ui";
import { DiffView } from "@/components/wiki/diff-view";
import { RestoreButton } from "@/components/wiki/restore-button";
import { makeWhen, type When } from "@/components/wiki/when";
import { requireUser } from "@/lib/auth";
import { getPrefs, getT, type TFn } from "@/lib/i18n";
import { diffStats, wordDiff } from "@/lib/wiki/diff";
import { getPage, listRevisions } from "@/lib/wiki";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const SLUG = /^[a-z0-9-]{1,120}$/;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const t = await getT();
  if (!SLUG.test(slug)) return { title: t("wiki.meta.notFound") };
  const v = await requireUser();
  const page = await getPage(v, slug);
  return { title: page ? t("wiki.meta.history", { title: page.title }) : t("wiki.meta.notFound") };
}

export default async function WikiHistory({ params, searchParams }: Props) {
  const { slug } = await params;
  if (!SLUG.test(slug)) notFound();
  const v = await requireUser();
  const page = await getPage(v, slug);
  if (!page) notFound();
  const revisions = await listRevisions(v, slug, { withText: true, limit: 200 });
  const sp = await searchParams;
  const [t, prefs] = await Promise.all([getT(), getPrefs()]);
  const when = makeWhen({ t, locale: prefs.locale, timeZone: prefs.timeZone });
  const selectedIdx = Math.max(0, revisions.findIndex((r) => r.id === sp.rev));
  const selected = revisions[selectedIdx];
  const previous = revisions[selectedIdx + 1];
  const pageHref = `/wiki/${encodeURIComponent(page.slug)}`;

  return (
    <div>
      <Link href={pageHref} className="-ml-2 mb-3 inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-fg">
        <ArrowLeft aria-hidden className="size-4" /><span className="max-w-[40ch] truncate">{page.title}</span>
      </Link>
      <PageHeader title={t("wiki.history.title")} lead={t("wiki.history.lead", { title: page.title })} />

      {!selected ? (
        <EmptyState title={t("wiki.history.noneTitle")}><p>{t("wiki.history.noneBody")}</p></EmptyState>
      ) : (
        <div className="grid gap-x-10 gap-y-8 lg:grid-cols-[17rem_minmax(0,1fr)]">
          <nav aria-label={t("wiki.history.versions")} className="order-2 lg:order-1">
            <h2 className="mb-2 text-sm font-semibold text-muted lg:sr-only">{t("wiki.history.all")}</h2>
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
                        {r.authorKind === "assistant" ? <AssistantAuthor name={r.authorName} t={t} /> : (
                          <span className="flex min-w-0 items-center gap-1.5 font-medium"><span className="truncate">{r.authorName}</span></span>
                        )}
                        <time dateTime={r.createdAt.toISOString()} title={when.full(r.createdAt)} className="shrink-0 text-sm tabular-nums text-muted">{listWhen(r.createdAt, when, t)}</time>
                      </span>
                      <span className="mt-0.5 block text-sm text-muted">
                        {i === 0 && <span className="font-medium text-fg">{t("wiki.history.current")} </span>}
                        {r.summary ?? (prev ? <ChangeCount added={stats.added} removed={stats.removed} t={t} /> : t("wiki.history.first"))}
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
                  {t(selectedIdx === 0 ? "wiki.history.versionCurrent" : "wiki.history.version", { n: selected.version })}
                </h2>
                <p className="mt-1 text-sm text-muted">
                  {selected.authorKind === "assistant"
                    ? <>{askedBy(selected.authorName)
                        ? t("wiki.history.assistantWroteAsked", { name: askedBy(selected.authorName) ?? "", when: when.sentence(selected.createdAt) })
                        : t("wiki.history.assistantWrote", { when: when.sentence(selected.createdAt) })}{selected.summary ? <> {selected.summary}{/[.!?]$/.test(selected.summary) ? "" : "."}</> : null}{" "}</>
                    : <>{t("wiki.history.savedBy", { name: selected.authorName, when: when.sentence(selected.createdAt) })}{" "}</>}
                  {previous ? t("wiki.history.comparedWith", { n: previous.version }) : t("wiki.history.isFirst")}
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

function AssistantAuthor({ name, t }: { name: string; t: TFn }) {
  const who = askedBy(name);
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Sparkles aria-hidden className="size-3.5 shrink-0 self-center text-accent" />
      <span className="shrink-0 font-medium">{t("wiki.history.assistant")}</span>
      {who && <span className="truncate text-sm text-muted">{t("wiki.history.askedBy", { name: who })}</span>}
    </span>
  );
}

function ChangeCount({ added, removed, t }: { added: number; removed: number; t: TFn }) {
  if (added === 0 && removed === 0) return <>{t("wiki.history.noChanges")}</>;
  return (
    <>
      {added > 0 && <span className="text-accent">{t("wiki.history.wordsAdded", { count: added })}</span>}
      {added > 0 && removed > 0 && ", "}
      {removed > 0 && <span className="text-danger">{added > 0 ? t("wiki.history.removedShort", { count: removed }) : t("wiki.history.wordsRemoved", { count: removed })}</span>}
    </>
  );
}

function listWhen(d: Date, when: When, t: TFn): string {
  return when.group(d) === "today" ? when.time(d) : t("wiki.history.listWhen", { day: when.short(d), time: when.time(d) });
}
