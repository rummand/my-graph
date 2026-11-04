import Link from "next/link";
import type { Viewer } from "@/lib/auth";
import { historyOf } from "@/lib/changes";
import { getLocale, getT } from "@/lib/i18n";
import { formatDate } from "@/components/provenance/labels";
import { historyLine } from "./pure";

const SHOWN = 12;

/**
 * "What changed": the history log for one thing (graph_events via historyOf), newest first, each line naming who
 * changed what and linking the proposal it came from. Scoped by historyOf to the viewer's graph and access.
 */
export async function HistoryPanel({ v, subjectId, name, className }: { v: Viewer; subjectId: string; name: string; className?: string }) {
  const [events, t, locale] = await Promise.all([
    historyOf(v, { subjectId, limit: 50 }).catch(() => []),
    getT(),
    getLocale(),
  ]);
  return (
    <section aria-labelledby="history-h" className={className}>
      <h2 id="history-h" className="font-semibold">{t("history.title")}</h2>
      {events.length === 0 ? (
        <p className="mt-1 text-sm text-muted">{t("history.empty", { name })}</p>
      ) : (
        <ol className="mt-3 space-y-3">
          {events.slice(0, SHOWN).map((e) => {
            const line = historyLine(e, t);
            return (
              <li key={e.id} className="grid grid-cols-[76px_minmax(0,1fr)] gap-3 text-sm">
                <time dateTime={new Date(e.at).toISOString()} className="pt-px text-xs tabular-nums text-muted">{formatDate(e.at, locale)}</time>
                <div className="min-w-0">
                  <p className="break-words">{line.head}</p>
                  {line.detail && <p className="break-words text-xs text-muted">{line.detail}</p>}
                  {e.changeSetId && (
                    <Link href={`/changes/${e.changeSetId}`} className="text-xs text-accent hover:underline">{t("history.showProposal")}</Link>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {events.length > SHOWN && <p className="mt-3 text-xs text-muted">{t("history.more", { count: events.length - SHOWN })}</p>}
    </section>
  );
}
