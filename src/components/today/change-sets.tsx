import Link from "next/link";
import { GitPullRequestArrow } from "lucide-react";
import type { ChangeSetView } from "@/lib/changes";
import { formatWhen } from "@/lib/briefs/dates";
import { getLocale, getT } from "@/lib/i18n";
import { hrefs, TodaySection } from "./section";

const ORIGINS = ["person", "assistant", "chat", "connector", "web", "ingest", "automation", "heartbeat", "keeper", "restore"];

/**
 * "Proposed changes": change sets an agent (reading a file or mail, a chat, a connector, a check-in) has proposed
 * for this graph and nobody has delivered yet. Nothing in them is in the graph until a person reviews and delivers
 * them on the change set's own page. (When the shared ChangeSetCard lands, it can replace these rows.)
 */
export async function ProposedChanges({ sets, now, tz }: { sets: ChangeSetView[]; now: Date; tz: string }) {
  if (!sets.length) return null;
  const [t, locale] = await Promise.all([getT(), getLocale()]);
  return (
    <TodaySection
      id="changes"
      title={<>{t("today.changes.title")}<span className="ml-2 rounded-full bg-warn-tint px-2 py-0.5 align-middle text-xs font-medium tabular-nums text-warn">{sets.length}</span></>}
    >
      <ul className="space-y-2">
        {sets.map((s) => {
          const open = s.changes.filter((c) => c.included).length || s.changes.length;
          return (
            <li key={s.id}>
              <Link href={hrefs.changeSet(s.id)} className="group flex items-start gap-3 rounded-lg bg-surface px-4 py-3 transition-colors hover:bg-surface/70">
                <GitPullRequestArrow aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium group-hover:underline">{s.title}</span>
                  <span className="block text-sm text-muted">
                    {t(`today.changes.origin.${ORIGINS.includes(s.origin) ? s.origin : "assistant"}`)}, {t("today.changes.count", { count: open })}
                  </span>
                </span>
                <time dateTime={new Date(s.createdAt).toISOString()} className="shrink-0 text-sm tabular-nums text-muted">{formatWhen(new Date(s.createdAt), now, tz, false, locale)}</time>
              </Link>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-sm text-muted">{t("today.changes.hint")}</p>
    </TodaySection>
  );
}
