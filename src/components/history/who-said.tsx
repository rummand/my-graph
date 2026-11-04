import Link from "next/link";
import type { Locale, TFn } from "@/lib/i18n/core";
import { Avatar } from "@/components/ui";
import { formatDate } from "@/components/provenance/labels";
import { whoSaid, type WhoSaidInput } from "./pure";

/**
 * "Who said so": every person, the assistant and the rules that told the graph about one thing, with how often and
 * their latest words. Built from provenance, so it works before the history log has anything. Server-safe.
 */
export function WhoSaid({ name, items, agents, t, locale, className }: {
  name: string; items: WhoSaidInput[]; agents: Record<string, string>; t: TFn; locale: Locale; className?: string;
}) {
  const rows = whoSaid(items);
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="who-said-h" className={className}>
      <h2 id="who-said-h" className="font-semibold">{t("history.whoSaid.title")}</h2>
      <p className="mt-0.5 text-sm text-muted">{t("history.whoSaid.lead", { name })}</p>
      <ul className="mt-4 space-y-4">
        {rows.slice(0, 8).map((r) => {
          const who = r.kind === "person"
            ? agents[r.userId ?? ""] ?? t("history.whoSaid.formerMember")
            : r.kind === "assistant" ? t("history.whoSaid.assistant") : t("history.whoSaid.rules");
          return (
            <li key={r.key} className="grid grid-cols-[auto_minmax(0,1fr)] gap-3 text-sm">
              {r.kind === "person"
                ? <Avatar id={r.userId ?? r.key} name={who.replace(/\s*\(.*\)$/, "")} size={28} />
                : <span aria-hidden className="grid size-7 place-items-center rounded-full bg-surface-2 text-xs text-muted">{r.kind === "assistant" ? "AI" : "R"}</span>}
              <div className="min-w-0">
                <p className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium">{who}</span>
                  <span className="text-xs text-muted tabular-nums">
                    {t("history.whoSaid.records", { count: r.count })}, {t("history.whoSaid.last", { date: formatDate(r.last, locale) })}
                  </span>
                </p>
                {r.quote && (
                  <p className="mt-1 break-words text-fg/85">
                    &ldquo;{r.quote.length > 160 ? `${r.quote.slice(0, 159)}…` : r.quote}&rdquo;
                    {r.sourceId && r.sourceTitle && (
                      <> <Link href={`/library/${r.sourceId}`} className="text-xs text-accent hover:underline">{r.sourceTitle}</Link></>
                    )}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
