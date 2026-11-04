import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { historyOf, type HistoryEvent } from "@/lib/changes";
import { listNodes, isUuid } from "@/lib/gbrain";
import { scopeOf } from "@/lib/graphs/pure";
import { compare, historyStartsAt, listCheckpoints } from "@/lib/history/read";
import { getFormatDate, getLocale, getT } from "@/lib/i18n";
import { formatDate as fmtDate } from "@/lib/i18n/dates";
import type { TFn } from "@/lib/i18n/core";
import { Button, EmptyState, PageHeader, Select } from "@/components/ui";
import { historyLine } from "@/components/history/pure";
import { CheckpointForm, RestoreButton } from "@/components/history/restore";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return { title: `${(await getT())("history.page.title")} · My Graph` };
}

type SP = { subjectId?: string; from?: string; to?: string; limit?: string };

const dateParam = (s: string | undefined) => (s && /^\d{4}-\d\d-\d\d$/.test(s) && !Number.isNaN(Date.parse(s)) ? s : null);

function subjectHref(e: HistoryEvent): string | null {
  if (e.subjectType === "node") return `/node/${e.subjectId}`;
  // A link event's subject is the link itself; the node in this graph is its fromNodeId.
  const from = (e as HistoryEvent & { fromNodeId?: string | null }).fromNodeId;
  if (e.subjectType === "link") return from ? `/node/${from}` : null;
  if (e.subjectType === "meta") return "/people/model";
  return null;
}

function subjectLabel(e: HistoryEvent, t: TFn): string {
  const name = e.subjectName ?? "";
  if (e.subjectType === "edge") return name || t("history.page.fact");
  if (e.subjectType === "meta") return `${t("history.page.model")}: ${name}`;
  if (e.subjectType === "wiki") return `${t("history.page.wikiPage")}: ${name}`;
  return name;
}

export default async function HistoryPage({ searchParams }: { searchParams: Promise<SP> }) {
  const v = await requireUser();
  const sp = await searchParams;
  const subjectId = sp.subjectId && isUuid(sp.subjectId) ? sp.subjectId : undefined;
  const limit = Math.min(Math.max(Number(sp.limit) || 100, 20), 500);
  const from = dateParam(sp.from), to = dateParam(sp.to);
  const [t, locale, fmt] = await Promise.all([getT(), getLocale(), getFormatDate()]);
  const [events, people, recent, startsAt, checkpoints] = await Promise.all([
    historyOf(v, { subjectId, limit }).catch(() => [] as HistoryEvent[]),
    listNodes(v, { type: "person", limit: 200 }).catch(() => []),
    subjectId ? Promise.resolve([] as HistoryEvent[]) : historyOf(v, { limit: 200 }).catch(() => [] as HistoryEvent[]),
    historyStartsAt(v).catch(() => null),
    listCheckpoints(v).catch(() => []),
  ]);
  const writer = scopeOf(v).canWrite;
  // Compare: from the start of `from` to the end of `to` (both in the reader's day, read as UTC midnight).
  const diff = from && to ? await compare(v, new Date(`${from}T00:00:00Z`), new Date(`${to}T23:59:59Z`)).catch(() => null) : null;
  const things = [...new Map((subjectId ? events : recent).filter((e) => e.subjectType === "node").map((e) => [e.subjectId, e.subjectName ?? ""])).entries()]
    .filter(([id]) => !people.some((p) => p.id === id)).slice(0, 40);
  const selectedName = subjectId ? people.find((p) => p.id === subjectId)?.label ?? things.find(([id]) => id === subjectId)?.[1] ?? null : null;

  // Group the feed by day, newest first.
  const days = new Map<string, HistoryEvent[]>();
  for (const e of events) {
    const k = fmtDate(e.at, "dateLong", { locale });
    days.set(k, [...(days.get(k) ?? []), e]);
  }
  const today = fmtDate(new Date(), "dateLong", { locale }), yesterday = fmtDate(new Date(Date.now() - 86_400_000), "dateLong", { locale });
  const dayLabel = (k: string) => (k === today ? t("history.page.today") : k === yesterday ? t("history.page.yesterday") : k);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title={t("history.page.title")} lead={t("history.page.lead", { graph: v.graphName })} />
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section aria-labelledby="feed-h" className="min-w-0">
          <h2 id="feed-h" className="sr-only">{t("history.page.title")}</h2>
          <form method="get" className="mb-6 flex flex-wrap items-end gap-2">
            <label className="min-w-0 flex-1 basis-60">
              <span className="mb-1 block text-sm text-muted">{t("history.page.filterLabel")}</span>
              <Select name="subjectId" defaultValue={subjectId ?? ""}>
                <option value="">{t("history.page.filterAll")}</option>
                {people.length > 0 && (
                  <optgroup label={t("history.page.filterPeople")}>
                    {people.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                  </optgroup>
                )}
                {things.length > 0 && (
                  <optgroup label={t("history.page.filterThings")}>
                    {things.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                  </optgroup>
                )}
              </Select>
            </label>
            {from && <input type="hidden" name="from" value={from} />}
            {to && <input type="hidden" name="to" value={to} />}
            <Button type="submit" variant="secondary">{t("history.page.apply")}</Button>
          </form>

          {selectedName && <p className="-mt-3 mb-5 text-sm text-muted">{t("history.page.about")} <Link href={`/node/${subjectId}`} className="font-medium text-fg hover:underline">{selectedName}</Link></p>}

          {events.length === 0 ? (
            <EmptyState title={t("history.page.nothingYet")} />
          ) : (
            <ol className="space-y-8">
              {[...days.entries()].map(([day, list]) => (
                <li key={day}>
                  <h3 className="mb-2 text-sm font-medium text-muted">{dayLabel(day)}</h3>
                  <ol className="relative space-y-0 border-l border-line pl-5">
                    {list.map((e) => {
                      const line = historyLine(e, t);
                      const href = subjectHref(e);
                      const label = subjectLabel(e, t);
                      return (
                        <li key={e.id} className="relative py-2.5">
                          <span aria-hidden className={`absolute -left-[25px] top-[17px] size-[9px] rounded-full ring-4 ring-bg ${e.changeSetId ? "bg-accent" : e.actorKind === "assistant" ? "bg-inferred" : "bg-muted"}`} />
                          <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                            {label && (href ? <Link href={href} className="font-medium hover:underline">{label}</Link> : <span className="font-medium">{label}</span>)}
                            <span className="text-fg/85">{line.head}</span>
                            <time dateTime={new Date(e.at).toISOString()} className="ml-auto text-xs tabular-nums text-muted">{fmt(e.at, "time")}</time>
                          </p>
                          {line.detail && <p className="mt-0.5 break-words text-sm text-muted">{line.detail}</p>}
                          {e.changeSetId && <Link href={`/changes/${e.changeSetId}`} className="text-xs text-accent hover:underline">{t("history.showProposal")}</Link>}
                        </li>
                      );
                    })}
                  </ol>
                </li>
              ))}
            </ol>
          )}
          {events.length >= limit && (
            <p className="mt-6"><Link className="text-sm text-accent hover:underline" href={`/history?${new URLSearchParams({ ...(subjectId ? { subjectId } : {}), limit: String(limit + 100) })}`}>{t("history.page.loadMore")}</Link></p>
          )}
          {startsAt && <p className="mt-8 text-xs text-muted">{t("history.page.startsAt", { date: fmt(startsAt, "dateLong") })}</p>}
        </section>

        <aside className="min-w-0 space-y-10 lg:sticky lg:top-8 lg:self-start">
          <section aria-labelledby="compare-h">
            <h2 id="compare-h" className="text-lg font-semibold">{t("history.compare.title")}</h2>
            <p className="mt-0.5 text-sm text-muted">{t("history.compare.lead")}</p>
            <form method="get" className="mt-3 grid grid-cols-2 gap-2">
              {subjectId && <input type="hidden" name="subjectId" value={subjectId} />}
              <label><span className="mb-1 block text-sm text-muted">{t("history.compare.from")}</span>
                <input type="date" name="from" defaultValue={from ?? ""} required className="h-9 w-full rounded-md border border-line bg-surface px-2 text-sm" /></label>
              <label><span className="mb-1 block text-sm text-muted">{t("history.compare.to")}</span>
                <input type="date" name="to" defaultValue={to ?? new Date().toISOString().slice(0, 10)} required className="h-9 w-full rounded-md border border-line bg-surface px-2 text-sm" /></label>
              <Button type="submit" variant="secondary" className="col-span-2">{t("history.compare.show")}</Button>
            </form>
            {diff && (
              <div className="mt-4 rounded-lg bg-surface p-4 text-sm">
                {[diff.nodesAdded, diff.nodesRemoved, diff.nodesChanged, diff.edgesAdded, diff.edgesRemoved, diff.edgesChanged].every((x) => x.length === 0) ? (
                  <p className="text-muted">{t("history.compare.nothing")}</p>
                ) : (
                  <>
                    <ul className="space-y-1.5">
                      {diff.nodesAdded.length > 0 && <li><span className="font-medium">{t("history.compare.added", { count: diff.nodesAdded.length })}</span>: <span className="text-muted">{diff.nodesAdded.slice(0, 6).map((n) => n.label).join(", ")}</span></li>}
                      {diff.nodesRemoved.length > 0 && <li><span className="font-medium">{t("history.compare.removed", { count: diff.nodesRemoved.length })}</span>: <span className="text-muted">{diff.nodesRemoved.slice(0, 6).map((n) => n.label).join(", ")}</span></li>}
                      {diff.nodesChanged.length > 0 && <li><span className="font-medium">{t("history.compare.changed", { count: diff.nodesChanged.length })}</span>: <span className="text-muted">{diff.nodesChanged.slice(0, 6).map((n) => n.after.label).join(", ")}</span></li>}
                      {diff.edgesAdded.length > 0 && <li className="font-medium">{t("history.compare.factsAdded", { count: diff.edgesAdded.length })}</li>}
                      {diff.edgesRemoved.length > 0 && <li className="font-medium">{t("history.compare.factsRemoved", { count: diff.edgesRemoved.length })}</li>}
                      {diff.edgesChanged.length > 0 && <li className="font-medium">{t("history.compare.factsChanged", { count: diff.edgesChanged.length })}</li>}
                    </ul>
                    {writer && from && (
                      <div className="mt-4">
                        <RestoreButton url="/api/history/restore" body={{ at: `${from}T00:00:00Z`, label: fmtDate(`${from}T12:00:00Z`, "date", { locale }) }}
                          label={t("history.compare.restore", { date: fmtDate(`${from}T12:00:00Z`, "date", { locale }) })} />
                        <p className="mt-2 text-xs text-muted">{t("history.compare.restoreHint")}</p>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </section>

          <section aria-labelledby="cp-h">
            <h2 id="cp-h" className="text-lg font-semibold">{t("history.checkpoints.title")}</h2>
            <p className="mt-0.5 text-sm text-muted">{t("history.checkpoints.lead")}</p>
            {writer && <div className="mt-3"><CheckpointForm /></div>}
            {checkpoints.length === 0 ? (
              <p className="mt-3 text-sm text-muted">{t("history.checkpoints.empty")}</p>
            ) : (
              <ul className="mt-4 divide-y divide-line/70">
                {checkpoints.map((c) => (
                  <li key={c.id} className="py-3">
                    <p className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <span className="font-medium">{c.label}</span>
                      <time dateTime={c.at.toISOString()} className="text-xs tabular-nums text-muted">{fmt(c.at, "dateTime")}</time>
                    </p>
                    {writer && <div className="mt-2"><RestoreButton url={`/api/checkpoints/${c.id}/restore`} body={{}} label={t("history.checkpoints.restore")} variant="ghost" /></div>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
