import type { Metadata } from "next";
import Link from "next/link";
import { FilePlus, Lock, Search, Users, X } from "lucide-react";
import { GraphWelcome } from "@/components/graphs/graph-welcome";
import { buttonClass, Input, PageHeader, PersonChip } from "@/components/ui";
import { visibilityBadge } from "@/components/wiki/copy";
import { makeWhen, RECENCY_GROUPS, type When } from "@/components/wiki/when";
import { requireUser } from "@/lib/auth";
import { scopeOf } from "@/lib/graphs/pure";
import { getPrefs, getT, type TFn } from "@/lib/i18n";
import { listPages, pagesByPerson, type WikiPageSummary } from "@/lib/wiki";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("wiki.meta.index") };
}
export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** The search word, highlighted where it appears in an excerpt. */
function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const out: React.ReactNode[] = [];
  let at = 0;
  for (let i = lower.indexOf(needle); i !== -1 && out.length < 12; i = lower.indexOf(needle, at)) {
    if (i > at) out.push(text.slice(at, i));
    out.push(<mark key={i} className="rounded-sm bg-accent-tint px-0.5 text-fg">{text.slice(i, i + q.length)}</mark>);
    at = i + q.length;
  }
  out.push(text.slice(at));
  return <>{out}</>;
}

function PageRow({ p, q = "", t, when, family }: { p: WikiPageSummary; q?: string; t: TFn; when: When; family: boolean }) {
  const badge = visibilityBadge(t, p.visibility, family);
  return (
    <li>
      <Link href={`/wiki/${encodeURIComponent(p.slug)}`}
        className="group -mx-3 grid gap-x-6 gap-y-1 rounded-lg px-3 py-3 transition-colors duration-150 hover:bg-surface sm:grid-cols-[minmax(0,1fr)_auto]">
        <span className="min-w-0">
          <span className="block break-words font-medium group-hover:text-accent">
            <Highlight text={p.title} q={q} />
          </span>
          {p.excerpt
            ? <span className="mt-0.5 line-clamp-2 block max-w-[68ch] font-read text-[15px] leading-relaxed text-muted"><Highlight text={p.excerpt} q={q} /></span>
            : <span className="mt-0.5 block text-sm text-muted">{t("wiki.index.nothingWritten")}</span>}
        </span>
        <span className="flex items-center gap-3 text-sm text-muted sm:flex-col sm:items-end sm:gap-0.5 sm:pt-0.5">
          <time dateTime={p.updatedAt.toISOString()} title={t("wiki.index.lastEdited", { when: when.full(p.updatedAt) })} className="whitespace-nowrap">
            {p.updatedByName
              ? t("wiki.index.editedBy", { name: p.updatedByName, when: when.short(p.updatedAt) === t("wiki.when.yesterday") ? t("wiki.when.yesterdayLower") : when.short(p.updatedAt) })
              : when.short(p.updatedAt)}
          </time>
          {badge && (
            <span className="inline-flex items-center gap-1 text-xs">
              {p.visibility === "private" ? <Lock aria-hidden className="size-3" /> : <Users aria-hidden className="size-3" />}
              {badge}
            </span>
          )}
        </span>
      </Link>
    </li>
  );
}

export default async function WikiIndex({ searchParams }: Props) {
  const v = await requireUser();
  const raw = await searchParams;
  const q = typeof raw.q === "string" ? raw.q.trim().slice(0, 200) : "";
  const scope = scopeOf(v);
  const canCreate = v.role !== "guest" && scope.canWrite;
  const family = v.graphKind === "family";
  const [t, prefs] = await Promise.all([getT(), getPrefs()]);
  const when = makeWhen({ t, locale: prefs.locale, timeZone: prefs.timeZone });

  const [pages, people] = await Promise.all([
    listPages(v, { q: q || undefined, limit: q ? 50 : 100 }),
    q ? Promise.resolve([]) : pagesByPerson(v).catch(() => []),
  ]);

  const groups = RECENCY_GROUPS.map((g) => ({ name: g, pages: pages.filter((p) => when.group(p.updatedAt) === g) })).filter((g) => g.pages.length > 0);

  const search = (
    <form role="search" action="/wiki" method="get" className="relative">
      <label htmlFor="wiki-q" className="sr-only">{t("wiki.index.searchLabel")}</label>
      <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
      <Input id="wiki-q" name="q" type="search" defaultValue={q} placeholder={t("wiki.index.searchPlaceholder")} className="h-10 pl-9" />
    </form>
  );

  return (
    <div>
      <PageHeader title={t("wiki.title")}
        lead={t(family ? "wiki.index.leadFamily" : "wiki.index.lead")}
        actions={canCreate ? (
          <Link href="/wiki/new" className={buttonClass("primary")}>
            <FilePlus aria-hidden className="size-4" />{t("wiki.index.newPage")}
          </Link>
        ) : undefined} />
      <GraphWelcome viewer={v} />

      <div className="grid gap-x-12 gap-y-10 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="min-w-0">
          <div className="mb-8 max-w-xl">{search}</div>

          {q ? (
            <section aria-labelledby="wiki-results">
              <div className="mb-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <h2 id="wiki-results" className="text-lg font-semibold tracking-[-0.01em]">
                  {pages.length === 0 ? t("wiki.index.noMatch", { q }) : pages.length === 50 ? t("wiki.index.matchesMore", { count: pages.length, q }) : t("wiki.index.matches", { count: pages.length, q })}
                </h2>
                <Link href="/wiki" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg"><X aria-hidden className="size-3.5" />{t("wiki.index.clearSearch")}</Link>
              </div>
              {pages.length === 0 ? (
                <p className="max-w-[60ch] text-muted">
                  {canCreate
                    ? <>{t("wiki.index.searchHelpCreate")} <Link href={`/wiki/new?title=${encodeURIComponent(q)}`} className="font-medium text-accent hover:underline">{t("wiki.index.startCalled", { q })}</Link>.</>
                    : t("wiki.index.searchHelp")}
                </p>
              ) : (
                <ul>{pages.map((p) => <PageRow key={p.id} p={p} q={q} t={t} when={when} family={family} />)}</ul>
              )}
            </section>
          ) : pages.length === 0 ? (
            <section className="rounded-lg bg-surface px-6 py-10 sm:px-10">
              <h2 className="text-lg font-semibold tracking-[-0.01em]">{t("wiki.index.nothingWritten")}</h2>
              <p className="mt-2 max-w-[56ch] font-read text-[17px] leading-[1.75] text-muted">
                {t(family ? "wiki.index.emptyBodyFamily" : "wiki.index.emptyBody")}
              </p>
              {canCreate && <Link href="/wiki/new" className={`${buttonClass("primary")} mt-6`}><FilePlus aria-hidden className="size-4" />{t("wiki.index.writeFirst")}</Link>}
            </section>
          ) : (
            <div className="space-y-8">
              {groups.map((g) => (
                <section key={g.name} aria-labelledby={`wiki-g-${g.name}`}>
                  <h2 id={`wiki-g-${g.name}`} className="mb-1 text-sm font-semibold text-muted">{when.groupLabel(g.name)}</h2>
                  <ul>{g.pages.map((p) => <PageRow key={p.id} p={p} t={t} when={when} family={family} />)}</ul>
                </section>
              ))}
              {pages.length === 100 && <p className="text-sm text-muted">{t("wiki.index.showingRecent")}</p>}
            </div>
          )}
        </div>

        {!q && pages.length > 0 && (
          <aside aria-labelledby="wiki-people" className="text-sm lg:pt-[72px]">
            <h2 id="wiki-people" className="mb-3 font-semibold">{t("wiki.index.aboutPeople")}</h2>
            {people.length === 0 ? (
              <p className="text-muted">{t("wiki.index.aboutPeopleEmpty")}</p>
            ) : (
              <ul className="space-y-5">
                {people.map((g) => (
                  <li key={g.person.id}>
                    <PersonChip id={g.person.id} name={g.person.label} href={`/people/${g.person.id}`} />
                    <ul className="mt-1.5 space-y-1 pl-3">
                      {g.pages.map((p) => (
                        <li key={p.slug}><Link href={`/wiki/${encodeURIComponent(p.slug)}`} className="break-words text-muted hover:text-fg">{p.title}</Link></li>
                      ))}
                      {g.total > g.pages.length && <li className="text-xs text-muted">{t("wiki.index.andMore", { count: g.total - g.pages.length })}</li>}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
