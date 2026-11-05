import type { Metadata } from "next";
import Link from "next/link";
import { clsx } from "clsx";
import { Search as SearchIcon } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { getFormatDate, getT, type TFn } from "@/lib/i18n";
import { search } from "@/lib/search";
import { sectionsFor } from "@/lib/search/access";
import { isSection, type Hit, type Section } from "@/lib/search/types";
import { listFolders, type FolderView } from "@/lib/ingest/folders";
import { buttonClass, EmptyState, PageHeader } from "@/components/ui";
import { HitIcon, Marked } from "@/components/search/bits";
import { SearchForm, type SearchFormValues } from "@/components/search/search-form";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return { title: `${(await getT())("search.title")} · My Graph` };
}

const PAGE = 20;
const one = (x: string | string[] | undefined) => (typeof x === "string" ? x : "");
const day = (x: string) => (/^\d{4}-\d{2}-\d{2}$/.test(x) ? x : "");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function flatFolders(list: FolderView[], out: { id: string; label: string }[] = []): { id: string; label: string }[] {
  for (const f of list) {
    out.push({ id: f.id, label: [...f.path, f.name].filter((x, i, a) => a.indexOf(x) === i).join(" / ") || f.name });
    flatFolders(f.children, out);
  }
  return out;
}

export default async function SearchPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const v = await requireUser();
  const sp = await searchParams;
  const [t, fmt] = await Promise.all([getT(), getFormatDate()]);
  const values: SearchFormValues = {
    q: one(sp.q).slice(0, 200), types: isSection(one(sp.types)) ? one(sp.types) : "",
    owner: one(sp.owner) === "me" || one(sp.owner) === "others" ? one(sp.owner) : "",
    from: day(one(sp.from)), to: day(one(sp.to)), folder: UUID.test(one(sp.folder)) ? one(sp.folder) : "",
    sort: one(sp.sort) === "newest" ? "newest" : "relevance",
  };
  const page = Math.max(1, Math.min(50, Number(one(sp.page)) || 1));
  const type = values.types ? (values.types as Section) : null;
  const allowed = sectionsFor(v);
  const to = values.to ? new Date(`${values.to}T00:00:00Z`) : null;
  if (to) to.setUTCDate(to.getUTCDate() + 1);

  const [res, folders] = await Promise.all([
    values.q ? search(v, {
      q: values.q, types: type ? [type] : undefined, mode: "full", limit: type ? PAGE : 6, offset: type ? (page - 1) * PAGE : 0,
      owner: (values.owner || null) as "me" | "others" | null, from: values.from ? new Date(`${values.from}T00:00:00Z`) : null, to,
      folder: values.folder || null, sort: values.sort as "relevance" | "newest",
    }) : Promise.resolve(null),
    listFolders(v).then((f) => flatFolders(f.folders)).catch(() => []),
  ]);

  const href = (patch: Partial<SearchFormValues & { page: number }>) => {
    const next = { ...values, page: undefined as number | undefined, ...patch };
    const p = new URLSearchParams();
    for (const [k, val] of Object.entries(next)) if (val && !(k === "sort" && val === "relevance") && !(k === "page" && val === 1)) p.set(k, String(val));
    return `/search?${p.toString()}`;
  };
  const sections = res?.sections ?? [];
  const total = sections.reduce((n, s) => n + s.items.length, 0);

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={t("search.title")} lead={t("search.lead", { graph: v.graphName })} />
      <SearchForm key={JSON.stringify(values)} values={values} folders={folders} showFolder={!type || type === "files"} />

      <nav aria-label={t("search.title")} className="mt-4 flex flex-wrap gap-1.5">
        <Chip href={href({ types: "", page: 1 })} on={!type}>{t("search.page.all")}</Chip>
        {allowed.map((s) => <Chip key={s} href={href({ types: s, page: 1, folder: s === "files" ? values.folder : "" })} on={type === s}>{t(`search.sections.${s}`)}</Chip>)}
      </nav>

      <div className="mt-8">
        {!values.q ? (
          <p className="text-sm text-muted">{t("search.page.tips")}</p>
        ) : total === 0 ? (
          <EmptyState icon={<SearchIcon className="size-6" aria-hidden />} title={t("search.noResults", { graph: v.graphName, q: res?.q ?? values.q })}
            action={<Link href={`/chat?q=${encodeURIComponent(values.q)}`} className={buttonClass("secondary", "sm")}>{t("search.cmd.askAbout", { q: values.q })}</Link>}>
            {t("search.noResultsHint")}
          </EmptyState>
        ) : (
          <div className="space-y-9">
            <p role="status" className="text-sm text-muted">
              {t("search.results", { count: total })}
              {res?.semantic ? ` · ${t("search.semanticOn")}` : ""}
              <span className="sr-only">. </span>
            </p>
            {res?.top && !type && (
              <section aria-labelledby="s-top">
                <h2 id="s-top" className="mb-2 text-lg font-semibold">{t("search.sections.top")}</h2>
                <ul><ResultRow h={res.top} t={t} fmt={fmt} big /></ul>
              </section>
            )}
            {sections.map((s) => {
              const items = s.items.filter((h) => type || h.key !== res?.top?.key);
              if (!items.length) return null;
              return (
                <section key={s.id} aria-labelledby={`s-${s.id}`}>
                  <h2 id={`s-${s.id}`} className="mb-2 text-lg font-semibold">{t(`search.sections.${s.id}`)}</h2>
                  <ul className="divide-y divide-line">{items.map((h) => <ResultRow key={h.key} h={h} t={t} fmt={fmt} />)}</ul>
                  {s.more && !type && (
                    <Link href={href({ types: s.id, page: 1 })} className="mt-2 inline-block text-sm text-accent hover:underline">
                      {t("search.page.showAll", { section: t(`search.sections.${s.id}`).toLowerCase() })}
                    </Link>
                  )}
                  {type && (page > 1 || s.more) && (
                    <div className="mt-4 flex items-center gap-4 text-sm">
                      {page > 1 && <Link href={href({ page: page - 1 })} className="text-accent hover:underline">{t("search.page.prev")}</Link>}
                      <span className="text-muted tabular-nums">{t("search.page.pageOf", { n: page })}</span>
                      {s.more && <Link href={href({ page: page + 1 })} className="text-accent hover:underline">{t("search.page.next")}</Link>}
                    </div>
                  )}
                </section>
              );
            })}
            <p className="text-xs text-muted tabular-nums">{t("search.page.took", { ms: res?.ms ?? 0 })}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function Chip({ href, on, children }: { href: string; on: boolean; children: React.ReactNode }) {
  return (
    <Link href={href} aria-current={on ? "page" : undefined}
      className={clsx("rounded-full px-3 py-1 text-sm transition-colors", on ? "bg-fg text-bg" : "bg-surface text-fg hover:bg-surface-2")}>
      {children}
    </Link>
  );
}

function ResultRow({ h, t, fmt, big = false }: { h: Hit; t: TFn; fmt: (d: string, s?: "date") => string; big?: boolean }) {
  const ctx = [...h.context];
  if (h.kind === "event" && h.date) ctx.splice(1, 0, fmt(h.date, "date"));
  else if (h.date && (h.section === "files" || h.section === "made" || h.section === "chats")) ctx.push(fmt(h.date, "date"));
  if (h.ownerName && h.section !== "chats") ctx.push(h.ownerName);
  return (
    <li>
      <Link href={h.href} className={clsx("flex gap-3 rounded-md px-2 py-3 hover:bg-surface", big && "bg-surface")}>
        <HitIcon kind={h.kind} sub={h.sub} title={h.title} colorId={h.colorId} size={big ? 36 : 32} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className={clsx("truncate", big ? "text-[17px] font-medium" : "text-[15px]")}><Marked text={h.title} ranges={h.titleRanges} /></div>
          <div className="truncate text-xs text-muted">{ctx.filter(Boolean).join(" · ")}</div>
          {h.snippet?.text ? (
            <p className="mt-1 line-clamp-2 text-sm text-muted"><Marked text={h.snippet.text} ranges={h.snippet.ranges} /></p>
          ) : h.sensitive ? (
            <p className="mt-1 text-sm text-muted">{t("search.sensitiveHidden")}</p>
          ) : null}
        </div>
      </Link>
    </li>
  );
}
