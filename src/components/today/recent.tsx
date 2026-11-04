import Link from "next/link";
import { FileText, Mail, NotebookText } from "lucide-react";
import type { TodayData } from "@/lib/briefs";
import { formatWhen } from "@/lib/briefs/dates";
import { getLocale, getT } from "@/lib/i18n";
import { hrefs, SectionError, TodaySection } from "./section";

type Row = { key: string; href: string; title: string; kind: "file" | "mail" | "wiki"; meta: string; warn: boolean; at: number };

/** Files, mail and wiki pages added or changed lately, newest first, in one list. */
export async function RecentlyAdded({ data, now, tz }: { data: Pick<TodayData, "recentSources" | "recentWiki">; now: Date; tz: string }) {
  const [t, locale] = await Promise.all([getT(), getLocale()]);
  const { recentSources, recentWiki } = data;
  const status = (s: string) => (s === "pending" ? t("today.recent.waiting") : s === "processing" ? t("today.recent.reading") : s === "failed" ? t("today.recent.failed") : "");
  const rows: Row[] = [
    ...(recentSources.ok ? recentSources.data.map((s): Row => ({
      key: `s:${s.id}`, href: hrefs.source(s.id), title: s.title, kind: s.kind === "email" ? "mail" : "file",
      meta: status(s.status) || formatWhen(s.createdAt, now, tz, false, locale), warn: s.status === "failed", at: s.createdAt.getTime(),
    })) : []),
    ...(recentWiki.ok ? recentWiki.data.map((p): Row => ({
      key: `w:${p.id}`, href: hrefs.wiki(p.slug), title: p.title, kind: "wiki",
      meta: formatWhen(p.updatedAt, now, tz, false, locale), warn: false, at: p.updatedAt.getTime(),
    })) : []),
  ].sort((a, b) => b.at - a.at).slice(0, 6);
  const ICON = { file: FileText, mail: Mail, wiki: NotebookText };

  return (
    <TodaySection id="recent" title={t("today.recent.title")}>
      {!recentSources.ok && <SectionError what={t("today.error.what.recentFiles")} className="mb-2" />}
      {!recentWiki.ok && <SectionError what={t("today.error.what.recentWiki")} className="mb-2" />}
      {rows.length === 0 ? (
        (recentSources.ok && recentWiki.ok) && (
          <p className="text-sm text-muted">
            {t("today.recent.emptyLead")}{" "}
            <Link href={hrefs.upload} className="text-accent hover:underline">{t("today.recent.emptyUpload")}</Link>{" "}
            {t("today.recent.emptyOr")}{" "}
            <Link href={hrefs.newWiki} className="text-accent hover:underline">{t("today.recent.emptyWiki")}</Link>.
          </p>
        )
      ) : (
        <ul>
          {rows.map((r) => {
            const Icon = ICON[r.kind];
            return (
              <li key={r.key}>
                <Link href={r.href} className="group -mx-2 flex min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-surface-2">
                  <Icon aria-hidden className="size-4 shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 truncate">{r.title}</span>
                  <span className="sr-only">{t(`today.recent.kind.${r.kind}`)}</span>
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
