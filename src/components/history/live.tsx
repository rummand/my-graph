"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { HistoryEvent } from "@/lib/changes";
import type { FieldBlame } from "@/lib/history/read";
import { useFormatDate, useT } from "@/lib/i18n/client";
import { fieldText, historyLine } from "./pure";

/**
 * "Last changed" for one thing (or one field of it): who, when, through which proposal, on what evidence. Reads
 * /api/history/who-said, which only answers about things the viewer may see. Client-safe, for client pages.
 */
export function WhoSaidField({ nodeId, field, className }: { nodeId: string; field?: string; className?: string }) {
  const t = useT();
  const fmt = useFormatDate();
  const [blame, setBlame] = useState<FieldBlame | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const q = new URLSearchParams({ nodeId, ...(field ? { field } : {}) });
    fetch(`/api/history/who-said?${q}`).then((r) => (r.ok ? r.json() : null)).then((d) => { if (live) setBlame(d?.blame ?? null); }).catch(() => live && setBlame(null));
    return () => { live = false; };
  }, [nodeId, field]);
  if (!blame) return null;
  const e = blame.event;
  const who = e.actorName || t(`history.actor.${e.actorKind}`, undefined, e.actorKind);
  return (
    <section aria-label={t("history.blame.title")} className={className}>
      <h2 className="font-semibold">{t("history.blame.title")}{field ? <span className="font-normal text-muted"> · {fieldText(field, t)}</span> : null}</h2>
      <p className="mt-1 text-sm">{historyLine(e, t).head}</p>
      <p className="text-xs text-muted">{t("history.blame.by", { who, date: fmt(e.at, "dateTime") })}</p>
      {blame.changeSet && (
        <p className="mt-1 text-sm"><Link href={`/changes/${blame.changeSet.id}`} className="text-accent hover:underline">{t("history.blame.via", { title: blame.changeSet.title })}</Link></p>
      )}
      {blame.evidence?.quote && (
        <blockquote className="mt-2 break-words border-l-2 border-accent/40 pl-3 text-sm text-fg/85">
          &ldquo;{blame.evidence.quote.length > 200 ? `${blame.evidence.quote.slice(0, 199)}…` : blame.evidence.quote}&rdquo;
          {blame.evidence.sourceId && blame.evidence.sourceTitle && <> <Link href={`/library/${blame.evidence.sourceId}`} className="text-xs text-accent hover:underline">{blame.evidence.sourceTitle}</Link></>}
        </blockquote>
      )}
    </section>
  );
}

/** The history panel for client pages (the person page): the latest changes to one thing, with a link to all of it. */
export function HistoryCard({ subjectId, name, className }: { subjectId: string; name: string; className?: string }) {
  const t = useT();
  const fmt = useFormatDate();
  const [events, setEvents] = useState<HistoryEvent[] | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/history?${new URLSearchParams({ subjectId, limit: "8" })}`).then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (live) setEvents(d?.events ?? []); }).catch(() => live && setEvents([]));
    return () => { live = false; };
  }, [subjectId]);
  if (events === null) return null;
  return (
    <section aria-label={t("history.title")} className={className}>
      <h2 className="font-semibold">{t("history.title")}</h2>
      {events.length === 0 ? (
        <p className="mt-1 text-sm text-muted">{t("history.empty", { name })}</p>
      ) : (
        <ol className="mt-3 space-y-3">
          {events.map((e) => {
            const line = historyLine(e, t);
            const about = e.subjectId !== subjectId && e.subjectName ? e.subjectName : null;
            return (
              <li key={e.id} className="grid grid-cols-[76px_minmax(0,1fr)] gap-3 text-sm">
                <time dateTime={new Date(e.at).toISOString()} className="pt-px text-xs tabular-nums text-muted">{fmt(e.at, "date")}</time>
                <div className="min-w-0">
                  <p className="break-words">{line.head}{about ? <span className="text-muted"> · {about}</span> : null}</p>
                  {line.detail && <p className="break-words text-xs text-muted">{line.detail}</p>}
                  {e.changeSetId && <Link href={`/changes/${e.changeSetId}`} className="text-xs text-accent hover:underline">{t("history.showProposal")}</Link>}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <p className="mt-3 text-sm"><Link href={`/history?subjectId=${subjectId}`} className="text-accent hover:underline">{t("history.page.title")}</Link></p>
    </section>
  );
}
