import type { Metadata } from "next";
import Link from "next/link";
import { FilePlus, Lock, Search, Users, X } from "lucide-react";
import { GraphWelcome } from "@/components/graphs/graph-welcome";
import { buttonClass, Input, PageHeader, PersonChip } from "@/components/ui";
import { fullWhen, recencyGroup, shortWhen, type RecencyGroup } from "@/components/wiki/when";
import { requireUser } from "@/lib/auth";
import { scopeOf } from "@/lib/graphs/pure";
import { listPages, pagesByPerson, type WikiPageSummary } from "@/lib/wiki";

export const metadata: Metadata = { title: "Wiki · My Graph" };
export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const GROUPS: RecencyGroup[] = ["Today", "This week", "This month", "Earlier this year", "Older"];

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

function PageRow({ p, q = "" }: { p: WikiPageSummary; q?: string }) {
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
            : <span className="mt-0.5 block text-sm text-muted">Nothing written yet</span>}
        </span>
        <span className="flex items-center gap-3 text-sm text-muted sm:flex-col sm:items-end sm:gap-0.5 sm:pt-0.5">
          <time dateTime={p.updatedAt.toISOString()} title={`Last edited ${fullWhen(p.updatedAt)}`} className="whitespace-nowrap">
            {p.updatedByName ? `${p.updatedByName}, ${shortWhen(p.updatedAt).replace(/^Yesterday$/, "yesterday")}` : shortWhen(p.updatedAt)}
          </time>
          {p.visibility !== "household" && (
            <span className="inline-flex items-center gap-1 text-xs">
              {p.visibility === "private" ? <Lock aria-hidden className="size-3" /> : <Users aria-hidden className="size-3" />}
              {p.visibility === "private" ? "Only you" : "Parents only"}
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
  const canCreate = v.role !== "guest" && scopeOf(v).canWrite;

  const [pages, people] = await Promise.all([
    listPages(v, { q: q || undefined, limit: q ? 50 : 100 }),
    q ? Promise.resolve([]) : pagesByPerson(v).catch(() => []),
  ]);

  const now = new Date();
  const groups = GROUPS.map((g) => ({ name: g, pages: pages.filter((p) => recencyGroup(p.updatedAt, now) === g) })).filter((g) => g.pages.length > 0);

  const search = (
    <form role="search" action="/wiki" method="get" className="relative">
      <label htmlFor="wiki-q" className="sr-only">Search pages</label>
      <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
      <Input id="wiki-q" name="q" type="search" defaultValue={q} placeholder="Search every page" className="h-10 pl-9" />
    </form>
  );

  return (
    <div>
      <PageHeader title="Wiki"
        lead="The family's own pages: plans, how-tos, notes from school and the doctor. Mention someone with @ and the page shows up on their profile."
        actions={canCreate ? (
          <Link href="/wiki/new" className={buttonClass("primary")}>
            <FilePlus aria-hidden className="size-4" />New page
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
                  {pages.length === 0 ? `Nothing matches “${q}”` : `${pages.length}${pages.length === 50 ? "+" : ""} ${pages.length === 1 ? "page matches" : "pages match"} “${q}”`}
                </h2>
                <Link href="/wiki" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg"><X aria-hidden className="size-3.5" />Clear search</Link>
              </div>
              {pages.length === 0 ? (
                <p className="max-w-[60ch] text-muted">
                  Search looks in page titles and text. Try a shorter word{canCreate
                    ? <>, or <Link href={`/wiki/new?title=${encodeURIComponent(q)}`} className="font-medium text-accent hover:underline">start a page called “{q}”</Link>.</>
                    : "."}
                </p>
              ) : (
                <ul>{pages.map((p) => <PageRow key={p.id} p={p} q={q} />)}</ul>
              )}
            </section>
          ) : pages.length === 0 ? (
            <section className="rounded-lg bg-surface px-6 py-10 sm:px-10">
              <h2 className="text-lg font-semibold tracking-[-0.01em]">Nothing written yet</h2>
              <p className="mt-2 max-w-[56ch] font-read text-[17px] leading-[1.75] text-muted">
                Write down what the family needs to remember: the packing list for summer, how the heating works, what the teacher said at the parent evening.
              </p>
              {canCreate && <Link href="/wiki/new" className={`${buttonClass("primary")} mt-6`}><FilePlus aria-hidden className="size-4" />Write the first page</Link>}
            </section>
          ) : (
            <div className="space-y-8">
              {groups.map((g) => (
                <section key={g.name} aria-labelledby={`wiki-g-${g.name}`}>
                  <h2 id={`wiki-g-${g.name}`} className="mb-1 text-sm font-semibold text-muted">{g.name}</h2>
                  <ul>{g.pages.map((p) => <PageRow key={p.id} p={p} />)}</ul>
                </section>
              ))}
              {pages.length === 100 && <p className="text-sm text-muted">Showing the 100 most recently edited pages. Search to find older ones.</p>}
            </div>
          )}
        </div>

        {!q && pages.length > 0 && (
          <aside aria-labelledby="wiki-people" className="text-sm lg:pt-[72px]">
            <h2 id="wiki-people" className="mb-3 font-semibold">Pages about people</h2>
            {people.length === 0 ? (
              <p className="text-muted">When a page mentions someone with @, it&apos;s listed under their name here.</p>
            ) : (
              <ul className="space-y-5">
                {people.map((g) => (
                  <li key={g.person.id}>
                    <PersonChip id={g.person.id} name={g.person.label} href={`/people/${g.person.id}`} />
                    <ul className="mt-1.5 space-y-1 pl-3">
                      {g.pages.map((p) => (
                        <li key={p.slug}><Link href={`/wiki/${encodeURIComponent(p.slug)}`} className="break-words text-muted hover:text-fg">{p.title}</Link></li>
                      ))}
                      {g.total > g.pages.length && <li className="text-xs text-muted">and {g.total - g.pages.length} more</li>}
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
