import type { Metadata } from "next";
import Link from "next/link";
import { z } from "zod";
import { Mic, Search } from "lucide-react";
import { buttonClass, EmptyState, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { listRecordings } from "@/lib/connectors/record/recordings";
import { formatDate, getPrefs, getT } from "@/lib/i18n";
import { clock } from "@/components/recording/timeline-math";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("recordings.metaTitle") };
}

const params = z.object({ q: z.string().max(200).optional().catch(undefined) });

/** /recordings: meetings from Record in this graph, newest first; each opens the player. */
export default async function RecordingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const v = await requireUser();
  const [t, { locale, timeZone }] = await Promise.all([getT(), getPrefs()]);
  const raw = await searchParams;
  const { q } = params.parse({ q: typeof raw.q === "string" ? raw.q : undefined });
  const list = await listRecordings(v, { q });
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title={t("recordings.title")} lead={t("recordings.lead", { graph: v.graphName })} />
      <form className="relative mb-6 max-w-md" role="search">
        <label htmlFor="rec-q" className="sr-only">{t("recordings.search")}</label>
        <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
        <input id="rec-q" name="q" type="search" defaultValue={q ?? ""} placeholder={t("recordings.search")}
          className="h-10 w-full rounded-md border border-line bg-surface pl-8 pr-3 text-[15px] outline-none focus-visible:ring-2 focus-visible:ring-accent" />
      </form>
      {list.length === 0 ? (
        <EmptyState icon={<Mic className="size-6" aria-hidden />} title={t("recordings.none")}
          action={!q ? <Link href="/connections" className={buttonClass("primary")}>{t("recordings.connect")}</Link> : undefined}>
          {t("recordings.noneBody")}
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line rounded-lg bg-surface">
          {list.map((r) => (
            <li key={r.id}>
              <Link href={`/recordings/${r.id}`} className="block px-4 py-4 hover:bg-surface-2/60 sm:px-5">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <span className="font-medium">{r.title}</span>
                  <span className="text-sm tabular-nums text-muted">
                    {r.tookPlace ? formatDate(r.tookPlace, "dateTime", { locale, timeZone }) : ""}{r.durationMs ? `, ${t("recordings.length", { length: clock(r.durationMs) })}` : ""}
                  </span>
                </div>
                {r.speakers.length > 0 && <p className="mt-0.5 text-sm text-muted">{t("recordings.with", { names: r.speakers.join(", ") })}</p>}
                {r.summary && <p className="mt-1 line-clamp-2 max-w-[75ch] text-sm">{r.summary}</p>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
