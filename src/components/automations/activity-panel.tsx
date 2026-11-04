"use client";
import { useState } from "react";
import Link from "next/link";
import { format, isToday, isYesterday } from "date-fns";
import { BellRing, FileText, MessageCircle, NotebookText, Workflow, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui";
import type { Activity } from "@/lib/automations";
import { api } from "./bits";

export type ActivityView = Omit<Activity, "createdAt"> & { createdAt: string };

const ICON: Record<string, LucideIcon> = { heartbeat: BellRing, automation: Workflow, chat: MessageCircle, ingest: FileText, wiki: NotebookText };

function dayLabel(d: Date) {
  return isToday(d) ? "Today" : isYesterday(d) ? "Yesterday" : format(d, "EEEE d MMMM");
}

function hrefFor(a: ActivityView): string | null {
  if (a.conversationId) return `/chat/${a.conversationId}`;
  if (!a.subjectId) return null;
  switch (a.subjectType) {
    case "node": return `/node/${a.subjectId}`;
    case "source": return `/library/${a.subjectId}`;
    case "memory": return "/memory";
    default: return null;
  }
}

/** What the assistant did and when; entries from a run open the run. */
export function ActivityPanel({ initial, onOpenRun }: { initial: ActivityView[]; onOpenRun: (id: string) => void }) {
  const [items, setItems] = useState(initial);
  const [more, setMore] = useState(initial.length >= 40);
  const [busy, setBusy] = useState(false);

  async function loadMore() {
    setBusy(true);
    try {
      const { activity } = await api<{ activity: ActivityView[] }>(`/api/activity?limit=${Math.min(items.length + 50, 200)}`);
      setItems(activity);
      setMore(activity.length > items.length && activity.length < 200);
    } finally {
      setBusy(false);
    }
  }

  if (!items.length) {
    return <p className="text-sm text-muted">Nothing yet. Each check-in, automation run, recipe and suggestion shows here with the time, so you can always see what the assistant did.</p>;
  }
  const groups: { day: string; items: ActivityView[] }[] = [];
  for (const a of items) {
    const d = dayLabel(new Date(a.createdAt));
    if (groups.at(-1)?.day !== d) groups.push({ day: d, items: [] });
    groups.at(-1)!.items.push(a);
  }
  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <div key={g.day}>
          <p className="mb-1 text-sm font-medium text-muted">{g.day}</p>
          <ul>
            {g.items.map((a) => {
              const Icon = ICON[a.actor] ?? MessageCircle;
              const href = hrefFor(a);
              const body = (
                <>
                  <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 text-sm"><span className="line-clamp-2">{a.summary}</span></span>
                  <time dateTime={a.createdAt} className="shrink-0 text-sm tabular-nums text-muted">{format(new Date(a.createdAt), "HH:mm")}</time>
                </>
              );
              const cls = "-mx-2 flex w-[calc(100%+1rem)] items-start gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-2";
              return (
                <li key={a.id}>
                  {a.runId ? <button className={cls} onClick={() => onOpenRun(a.runId!)}>{body}</button>
                    : href ? <Link href={href} className={cls}>{body}</Link>
                      : <div className="-mx-2 flex items-start gap-2.5 px-2 py-1.5">{body}</div>}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {more && <Button size="sm" variant="ghost" onClick={loadMore} disabled={busy}>{busy ? "Loading…" : "Show more"}</Button>}
    </div>
  );
}
