import Link from "next/link";
import { BellRing, Brain, FileText, MessageCircle, NotebookText, Workflow, type LucideIcon } from "lucide-react";
import type { Activity } from "@/lib/automations";
import { activityActorLabel, activityHref, hrefsAssistant } from "@/lib/briefs/assistant-home";
import { formatWhen } from "@/lib/briefs/dates";
import { getLocale, getT } from "@/lib/i18n";
import { SectionError, TodaySection } from "./section";

const ICON: Record<string, LucideIcon> = { heartbeat: BellRing, automation: Workflow, chat: MessageCircle, ingest: FileText, wiki: NotebookText, keeper: Brain };

/** "What the assistant did": the last few things it did in this graph, each linking to its chat, run or subject. */
export async function AssistantActivity({ activity, now, tz }: { activity: Activity[] | null; now: Date; tz: string }) {
  const [t, locale] = await Promise.all([getT(), getLocale()]);
  return (
    <TodaySection
      id="activity"
      title={t("today.activity.title")}
      action={activity && activity.length > 0 ? <Link href={hrefsAssistant.activity} className="text-sm text-accent hover:underline">{t("today.activity.all")}</Link> : undefined}
    >
      {activity === null ? <SectionError what={t("today.error.what.activity")} /> : activity.length === 0 ? (
        <p className="text-sm text-muted">{t("today.activity.empty")}</p>
      ) : (
        <ul>
          {activity.slice(0, 5).map((a) => {
            const href = activityHref(a);
            const Icon = ICON[a.actor] ?? MessageCircle;
            const at = new Date(a.createdAt);
            const body = (
              <>
                <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2">{a.summary}</span>
                  <span className="sr-only">, {activityActorLabel(a.actor, locale)}</span>
                </span>
                <time dateTime={at.toISOString()} className="shrink-0 text-sm tabular-nums text-muted">{formatWhen(at, now, tz, true, locale)}</time>
              </>
            );
            return (
              <li key={a.id}>
                {href ? (
                  <Link href={href} className="-mx-2 flex items-start gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-surface-2">{body}</Link>
                ) : (
                  <div className="-mx-2 flex items-start gap-2.5 px-2 py-1.5">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </TodaySection>
  );
}
