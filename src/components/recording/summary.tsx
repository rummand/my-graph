"use client";
/**
 * The meeting's summary, decisions and to-dos, with "Read aloud": the summary read sentence by sentence (My Graph's
 * voice through mux, else the device's), the sentence being read marked and the word in it under the finger.
 */
import { useMemo } from "react";
import { clsx } from "clsx";
import { Square, Volume2 } from "lucide-react";
import { useFormatDate, useLocale, useT } from "@/lib/i18n/client";
import { useReadAloud } from "./use-read-aloud";
import { sentences, wordsOf } from "./timeline-math";

export function SummaryBlock({ id, summary, decisions, todos }: {
  id: string; summary: string | null; decisions: string[]; todos: { text: string; owner: string | null; due: string | null; done: boolean }[];
}) {
  const t = useT();
  const locale = useLocale();
  const fmt = useFormatDate();
  const parts = useMemo(() => sentences(summary ?? ""), [summary]);
  const reader = useReadAloud(parts.map((p) => p.text), { language: locale === "da" ? "da" : "en", sourceId: id });
  if (!summary && !decisions.length && !todos.length) return null;
  return (
    <div className="space-y-6">
      {summary && (
        <section aria-labelledby="rec-sum-h">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 id="rec-sum-h" className="text-lg font-semibold">{t("recordings.summary.title")}</h2>
            <button type="button" onClick={() => (reader.reading ? reader.stop() : reader.start(0))}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted hover:bg-surface-2 hover:text-fg"
              aria-label={reader.reading ? t("recordings.readAloud.stop") : t("recordings.readAloud.summary")}>
              {reader.reading ? <Square aria-hidden className="size-3.5" /> : <Volume2 aria-hidden className="size-4" />}
              {reader.reading ? t("recordings.readAloud.stop") : t("recordings.readAloud.start")}
            </button>
          </div>
          <p className="text-[15px] leading-7">
            {parts.map((p, si) => {
              const on = reader.state?.item === si;
              const ws = wordsOf(p.text);
              return (
                <span key={si} className={clsx("rounded-sm transition-colors", on && "bg-surface-2")}>
                  {on ? ws.map((w, wi) => (
                    <span key={wi} className={clsx("rounded-[4px]", wi === reader.state?.word && "bg-accent-tint ring-1 ring-accent/40")}>{p.text.slice(w.start, w.end)}{wi < ws.length - 1 ? " " : ""}</span>
                  )) : p.text}{" "}
                </span>
              );
            })}
          </p>
          {reader.voice === "browser" && reader.reading && <p className="mt-1 text-xs text-muted">{t("recordings.readAloud.browserVoice")}</p>}
          {reader.error === "unsupported" && <p className="mt-1 text-xs text-muted">{t("recordings.readAloud.unsupported")}</p>}
        </section>
      )}
      {decisions.length > 0 && (
        <section aria-labelledby="rec-dec-h">
          <h2 id="rec-dec-h" className="mb-2 text-lg font-semibold">{t("recordings.summary.decisions")}</h2>
          <ul className="list-disc space-y-1 pl-5 text-[15px]">{decisions.map((d, i) => <li key={i}>{d}</li>)}</ul>
        </section>
      )}
      {todos.length > 0 && (
        <section aria-labelledby="rec-todo-h">
          <h2 id="rec-todo-h" className="mb-2 text-lg font-semibold">{t("recordings.summary.todos")}</h2>
          <ul className="space-y-1.5 text-[15px]">
            {todos.map((x, i) => (
              <li key={i} className={clsx(x.done && "text-muted line-through")}>
                {x.owner && <span className="font-medium">{x.owner}: </span>}{x.text}
                {x.due && <span className="text-sm text-muted"> ({t("recordings.summary.due", { date: fmt(`${x.due}T12:00:00Z`, "date") })})</span>}
                {x.done && <span className="sr-only"> ({t("recordings.summary.done")})</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
