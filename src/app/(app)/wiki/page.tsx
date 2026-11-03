import type { Metadata } from "next";
import Link from "next/link";
import { format, isThisYear, isToday, isYesterday } from "date-fns";
import { FilePlus, Search } from "lucide-react";
import { buttonClass, EmptyState, Input, PageHeader, Panel, PersonChip } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { listPages, pagesByPerson, type WikiPageSummary } from "@/lib/wiki";
import { VISIBILITY_LABEL } from "@/lib/wiki/labels";

export const metadata: Metadata = { title: "Wiki · My Graph" };
export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

function when(d: Date): string {
  if (isToday(d)) return `Today, ${format(d, "HH:mm")}`;
  if (isYesterday(d)) return "Yesterday";
  return format(d, isThisYear(d) ? "EEE d MMM" : "d MMM yyyy");
}

function PageRow({ p }: { p: WikiPageSummary }) {
  return (
    <li>
      <Link href={`/wiki/${encodeURIComponent(p.slug)}`} className="block px-4 py-3.5 transition-colors hover:bg-surface-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
          <span className="min-w-0 break-words font-medium">{p.title}</span>
          <span className="shrink-0 text-sm tabular-nums text-muted">
            <time dateTime={p.updatedAt.toISOString()} title={p.updatedAt.toLocaleString()}>{when(p.updatedAt)}</time>{p.updatedByName ? `, ${p.updatedByName}` : ""}
          </span>
        </div>
        {p.excerpt && <p className="mt-1 line-clamp-2 max-w-[70ch] text-sm text-muted">{p.excerpt}</p>}
        <p className="mt-1 text-xs text-muted">{VISIBILITY_LABEL[p.visibility]}</p>
      </Link>
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
    <div>
      <PageHeader title="Wiki"
        lead="Pages you write together: plans, how-tos, notes about school, health and holidays. Mention someone with @ or another page with [[ and it shows up in the graph."
        actions={canCreate ? (
          <Link href="/wiki/new" className={buttonClass("primary")}>
            <FilePlus aria-hidden className="size-4" />New page
          </Link>
        ) : undefined} />

      <form role="search" action="/wiki" method="get" className="mb-8 max-w-md">
        <label htmlFor="wiki-q" className="sr-only">Search pages</label>
        <div className="relative">
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <Input id="wiki-q" name="q" type="search" defaultValue={q} placeholder="Search titles and text, then press Enter" className="pl-9" />
        </div>
      </form>

      {q ? (
        <section aria-labelledby="wiki-results">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="wiki-results" className="text-lg font-semibold tracking-[-0.01em]">{pages.length === 0 ? "No matches" : `${pages.length}${pages.length === 50 ? "+" : ""} page${pages.length === 1 ? "" : "s"} matching “${q}”`}</h2>
            <Link href="/wiki" className="text-sm text-accent hover:underline">Clear search</Link>
          </div>
          {pages.length === 0 ? (
            <EmptyState title={`Nothing matches “${q}”`}>
              <p>Try a shorter word, or {canCreate ? <Link href={`/wiki/new?title=${encodeURIComponent(q)}`} className="text-accent hover:underline">start a page called “{q}”</Link> : "check the spelling"}.</p>
            </EmptyState>
          ) : (
            <Panel className="overflow-hidden p-0"><ul className="divide-y divide-line">{pages.map((p) => <PageRow key={p.id} p={p} />)}</ul></Panel>
          )}
        </section>
      ) : pages.length === 0 ? (
        <EmptyState title="No pages yet">
          <p>Write down what the family needs to remember: the packing list for summer, how the heating works, notes from the parent–teacher meeting.</p>
          {canCreate && <Link href="/wiki/new" className="mt-3 inline-block font-medium text-accent hover:underline">Write the first page</Link>}
        </EmptyState>
      ) : (
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <section aria-labelledby="wiki-recent">
            <h2 id="wiki-recent" className="mb-3 text-lg font-semibold tracking-[-0.01em]">Recently edited</h2>
            <Panel className="overflow-hidden p-0"><ul className="divide-y divide-line">{pages.map((p) => <PageRow key={p.id} p={p} />)}</ul></Panel>
          </section>
          <section aria-labelledby="wiki-people">
            <h2 id="wiki-people" className="mb-3 text-lg font-semibold tracking-[-0.01em]">Pages by person</h2>
            {people.length === 0 ? (
              <p className="text-sm text-muted">When a page mentions someone with @, it&apos;s listed under their name here.</p>
            ) : (
              <ul className="space-y-4">
                {people.map((g) => (
                  <li key={g.person.id}>
                    <PersonChip id={g.person.id} name={g.person.label} href={`/people/${g.person.id}`} />
                    <ul className="mt-1.5 space-y-1 pl-1">
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
