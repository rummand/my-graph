import Link from "next/link";
import { FileText, NotebookText } from "lucide-react";
import type { TodayData } from "@/lib/briefs";
import { formatWhen } from "@/lib/briefs/dates";
import { hrefs, SectionError, TodaySection } from "./section";

const STATUS: Record<string, string> = { pending: "Waiting", processing: "Reading…", ready: "", failed: "Couldn't read" };

type Row = { key: string; href: string; title: string; kind: "file" | "wiki"; meta: string; warn: boolean; at: number };

/** Files and wiki pages added or changed lately, newest first, in one list. */
export function RecentlyAdded({ data, now, tz }: { data: Pick<TodayData, "recentSources" | "recentWiki">; now: Date; tz: string }) {
  const { recentSources, recentWiki } = data;
  const rows: Row[] = [
    ...(recentSources.ok ? recentSources.data.map((s): Row => ({
      key: `s:${s.id}`, href: hrefs.source(s.id), title: s.title, kind: "file",
      meta: STATUS[s.status] || formatWhen(s.createdAt, now, tz, false), warn: s.status === "failed", at: s.createdAt.getTime(),
    })) : []),
    ...(recentWiki.ok ? recentWiki.data.map((p): Row => ({
      key: `w:${p.id}`, href: hrefs.wiki(p.slug), title: p.title, kind: "wiki",
      meta: formatWhen(p.updatedAt, now, tz, false), warn: false, at: p.updatedAt.getTime(),
    })) : []),
  ].sort((a, b) => b.at - a.at).slice(0, 6);

  return (
    <TodaySection
      id="recent"
      title="Recently added"
    >
      {!recentSources.ok && <SectionError what="recent files" className="mb-2" />}
      {!recentWiki.ok && <SectionError what="recent wiki pages" className="mb-2" />}
      {rows.length === 0 ? (
        (recentSources.ok && recentWiki.ok) && (
          <p className="text-sm text-muted">
            Nothing yet. <Link href={hrefs.upload} className="text-accent hover:underline">Upload a letter, photo or recording</Link> or{" "}
            <Link href={hrefs.newWiki} className="text-accent hover:underline">start a wiki page</Link>.
          </p>
        )
      ) : (
        <ul>
          {rows.map((r) => {
            const Icon = r.kind === "file" ? FileText : NotebookText;
            return (
              <li key={r.key}>
                <Link href={r.href} className="group -mx-2 flex min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-surface-2">
                  <Icon aria-hidden className="size-4 shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 truncate">{r.title}</span>
                  <span className="sr-only">{r.kind === "file" ? "File" : "Wiki page"}</span>
                  <span className={`shrink-0 text-sm tabular-nums ${r.warn ? "text-warn" : "text-muted"}`}>{r.meta}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </TodaySection>
  );
}
