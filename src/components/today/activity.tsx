import Link from "next/link";
import { BellRing, FileText, MessageCircle, NotebookText, Workflow, type LucideIcon } from "lucide-react";
import type { Activity } from "@/lib/automations";
import { activityActorLabel, activityHref, hrefsAssistant } from "@/lib/briefs/assistant-home";
import { formatWhen } from "@/lib/briefs/dates";
import { SectionError, TodaySection } from "./section";

const ICON: Record<string, LucideIcon> = { heartbeat: BellRing, automation: Workflow, chat: MessageCircle, ingest: FileText, wiki: NotebookText };

/** "What the assistant did": the last few things it did in this graph, each linking to its chat, run or subject. */
export function AssistantActivity({ activity, now, tz }: { activity: Activity[] | null; now: Date; tz: string }) {
  return (
    <TodaySection
      id="activity"
      title="What the assistant did"
      action={activity && activity.length > 0 ? <Link href={hrefsAssistant.activity} className="text-sm text-accent hover:underline">All activity</Link> : undefined}
    >
      {activity === null ? <SectionError what="the assistant's activity" /> : activity.length === 0 ? (
        <p className="text-sm text-muted">
          Nothing yet. When it answers, checks in or suggests something, it shows here with the time, and anything it
          wants to save waits for you above.
        </p>
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
                  <span className="sr-only">, {activityActorLabel(a.actor)}</span>
                </span>
                <time dateTime={at.toISOString()} className="shrink-0 text-sm tabular-nums text-muted">{formatWhen(at, now, tz)}</time>
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
