import Link from "next/link";
import { Card } from "@/components/ui";
import type { TodayData } from "@/lib/briefs";
import { formatWhen } from "@/lib/briefs/dates";
import { hrefs, SectionError, TodaySection } from "./section";

const STATUS: Record<string, string> = { pending: "Waiting", processing: "Reading…", ready: "", failed: "Failed" };

export function RecentlyAdded({ data, now, tz }: { data: Pick<TodayData, "recentSources" | "recentWiki">; now: Date; tz: string }) {
  const { recentSources, recentWiki } = data;
  return (
    <TodaySection id="recent" title="Recently added">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
        <Card className="min-w-0 text-sm">
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Files</h3>
          {!recentSources.ok ? <SectionError what="recent files" /> : recentSources.data.length === 0 ? (
            <p className="text-muted">No files yet. <Link href={hrefs.upload} className="text-accent hover:underline">Upload a letter, photo or recording</Link>.</p>
          ) : (
            <ul className="space-y-1.5">
              {recentSources.data.map((s) => (
                <li key={s.id} className="flex min-w-0 items-baseline justify-between gap-2">
                  <Link href={hrefs.source(s.id)} className="truncate hover:underline">{s.title}</Link>
                  <span className="shrink-0 text-xs text-muted">{STATUS[s.status] || formatWhen(s.createdAt, now, tz, false)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card className="min-w-0 text-sm">
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Wiki pages</h3>
          {!recentWiki.ok ? <SectionError what="recent wiki pages" /> : recentWiki.data.length === 0 ? (
            <p className="text-muted">No pages yet. <Link href={hrefs.newWiki} className="text-accent hover:underline">Start one</Link>.</p>
          ) : (
            <ul className="space-y-1.5">
              {recentWiki.data.map((p) => (
                <li key={p.id} className="flex min-w-0 items-baseline justify-between gap-2">
                  <Link href={hrefs.wiki(p.slug)} className="truncate hover:underline">{p.title}</Link>
                  <span className="shrink-0 text-xs text-muted">{formatWhen(p.updatedAt, now, tz, false)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </TodaySection>
  );
}
