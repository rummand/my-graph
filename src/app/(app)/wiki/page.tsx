import type { Metadata } from "next";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { FilePlus, Search } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { listPages, pagesByPerson, type WikiPageSummary } from "@/lib/wiki";
import { VISIBILITY_LABEL } from "@/lib/wiki/labels";

export const metadata: Metadata = { title: "Wiki · My Graph" };
export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

function PageRow({ p }: { p: WikiPageSummary }) {
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <Link href={`/wiki/${encodeURIComponent(p.slug)}`} className="min-w-0 break-words font-medium hover:text-accent hover:underline">{p.title}</Link>
        <span className="shrink-0 text-xs text-muted">
          <time dateTime={p.updatedAt.toISOString()} title={p.updatedAt.toLocaleString()}>{formatDistanceToNow(p.updatedAt, { addSuffix: true })}</time>
          {p.updatedByName ? ` by ${p.updatedByName}` : ""} · {VISIBILITY_LABEL[p.visibility]}
        </span>
      </div>
      {p.excerpt && <p className="mt-1 line-clamp-2 max-w-[70ch] text-sm text-muted">{p.excerpt}</p>}
    </li>
  );
}

export default async function WikiIndex({ searchParams }: Props) {
  const v = await requireUser();
  const raw = await searchParams;
  const q = typeof raw.q === "string" ? raw.q.trim().slice(0, 200) : "";
  const canCreate = v.role !== "guest";

  const [pages, people] = await Promise.all([
    listPages(v, { q: q || undefined, limit: q ? 50 : 20 }),
    q ? Promise.resolve([]) : pagesByPerson(v).catch(() => []),
  ]);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Wiki"
        lead="Pages you write together: plans, how-tos, notes about school, health and holidays. Mention people with @ and link pages with [[ — everything you mention shows up in the graph."
        actions={canCreate ? (
          <Link href="/wiki/new" className="inline-flex items-center gap-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-fg hover:opacity-90">
            <FilePlus aria-hidden className="size-4" />New page
          </Link>
        ) : undefined} />

      <form role="search" action="/wiki" method="get" className="mb-8 flex max-w-xl gap-2">
        <label htmlFor="wiki-q" className="sr-only">Search pages</label>
        <div className="relative flex-1">
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <input id="wiki-q" name="q" type="search" defaultValue={q} placeholder="Search titles and text"
            className="w-full rounded-md border border-line bg-surface py-2 pl-9 pr-3 text-sm placeholder:text-muted" />
        </div>
        <button type="submit" className="rounded-md border border-line bg-surface px-3 py-2 text-sm font-medium hover:bg-surface-2">Search</button>
      </form>

      {q ? (
        <section aria-labelledby="wiki-results">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="wiki-results" className="text-lg font-semibold">{pages.length === 0 ? "No matches" : `${pages.length}${pages.length === 50 ? "+" : ""} page${pages.length === 1 ? "" : "s"} matching “${q}”`}</h2>
            <Link href="/wiki" className="text-sm text-accent hover:underline">Clear search</Link>
          </div>
          {pages.length === 0 ? (
            <EmptyState title={`Nothing matches “${q}”`}>
              <p>Try a shorter word, or {canCreate ? <Link href={`/wiki/new?title=${encodeURIComponent(q)}`} className="text-accent hover:underline">start a page called “{q}”</Link> : "check the spelling"}.</p>
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line">{pages.map((p) => <PageRow key={p.id} p={p} />)}</ul>
          )}
        </section>
      ) : pages.length === 0 ? (
        <EmptyState title="No pages yet">
          <p>Write down what the family needs to remember: the packing list for summer, how the heating works, notes from the parent–teacher meeting.</p>
          {canCreate && <Link href="/wiki/new" className="mt-3 inline-block font-medium text-accent hover:underline">Write the first page</Link>}
        </EmptyState>
      ) : (
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <section aria-labelledby="wiki-recent">
            <h2 id="wiki-recent" className="mb-1 text-lg font-semibold">Recently edited</h2>
            <ul className="divide-y divide-line">{pages.map((p) => <PageRow key={p.id} p={p} />)}</ul>
          </section>
          <section aria-labelledby="wiki-people">
            <h2 id="wiki-people" className="mb-3 text-lg font-semibold">Pages by person</h2>
            {people.length === 0 ? (
              <p className="text-sm text-muted">When a page mentions someone with @, it&apos;s listed under their name here.</p>
            ) : (
              <ul className="space-y-4">
                {people.map((g) => (
                  <li key={g.person.id}>
                    <Link href={`/node/${g.person.id}`} className="text-sm font-medium hover:text-accent hover:underline" style={{ color: "var(--t-person)" }}>{g.person.label}</Link>
                    <ul className="mt-1 space-y-0.5">
                      {g.pages.map((p) => (
                        <li key={p.slug} className="text-sm"><Link href={`/wiki/${encodeURIComponent(p.slug)}`} className="break-words text-muted hover:text-fg hover:underline">{p.title}</Link></li>
                      ))}
                      {g.total > g.pages.length && <li className="text-xs text-muted">and {g.total - g.pages.length} more</li>}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
