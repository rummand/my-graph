"use client";
import { useEffect, useRef, useState } from "react";
import { clsx } from "clsx";
import { clock } from "./clock";

export type PlayerChapter = { id: string; title: string; start: number };
export type PlayerLine = { t: number; text: string };

/**
 * The film with its chapters (click to seek) and transcript (click a time to jump). Captions come from the WebVTT
 * track. The current chapter and paragraph follow the playhead.
 */
export function VideoPlayer({ src, poster, vtt, captionsLabel, noVideo, chapters, chaptersTitle, transcript, transcriptTitle, transcriptLead, jumpLabel, startAt }: {
  src: string; poster?: string; vtt?: string; captionsLabel: string; noVideo: string;
  chapters: PlayerChapter[]; chaptersTitle: string;
  transcript: PlayerLine[]; transcriptTitle: string; transcriptLead: string; jumpLabel: string;
  startAt?: number;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [now, setNow] = useState(startAt ?? 0);

  useEffect(() => {
    const v = ref.current;
    if (!v || !startAt) return;
    const go = () => { v.currentTime = startAt; };
    if (v.readyState >= 1) go(); else v.addEventListener("loadedmetadata", go, { once: true });
  }, [startAt]);

  const seek = (t: number) => {
    const v = ref.current;
    if (!v) return;
    v.currentTime = t;
    void v.play().catch(() => {});
    v.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };
  const current = <T extends { start?: number; t?: number }>(list: T[], at: (x: T) => number) => {
    let k = -1;
    list.forEach((x, i) => { if (at(x) <= now + 0.25) k = i; });
    return k;
  };
  const ch = current(chapters, (c) => c.start);
  const line = current(transcript, (l) => l.t);

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="min-w-0">
        <video ref={ref} controls preload="metadata" playsInline poster={poster} onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)}
          className="aspect-video w-full rounded-lg bg-fg">
          <source src={src} type="video/mp4" />
          {vtt && <track kind="captions" src={vtt} srcLang="en" label={captionsLabel} default />}
          {noVideo}
        </video>
      </div>
      <nav aria-label={chaptersTitle} className="min-w-0 lg:row-span-2">
        <h2 className="mb-2 text-lg font-semibold tracking-[-0.01em]">{chaptersTitle}</h2>
        <ol className="flex flex-col">
          {chapters.map((c, i) => (
            <li key={c.id}>
              <button type="button" onClick={() => seek(c.start)} aria-current={i === ch ? "true" : undefined}
                className={clsx("flex w-full items-baseline gap-3 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                  i === ch ? "bg-surface font-medium text-fg" : "text-muted hover:bg-surface-2/70 hover:text-fg")}>
                <span className="w-11 shrink-0 tabular-nums text-accent">{clock(c.start)}</span>
                <span className="min-w-0">{c.title}</span>
              </button>
            </li>
          ))}
        </ol>
      </nav>
      <section aria-labelledby="transcript-h" className="min-w-0">
        <h2 id="transcript-h" className="text-lg font-semibold tracking-[-0.01em]">{transcriptTitle}</h2>
        <p className="mb-4 mt-1 text-sm text-muted">{transcriptLead}</p>
        <div className="flex flex-col gap-3">
          {transcript.map((l, i) => (
            <p key={i} className={clsx("flex gap-3 rounded-md px-2 py-1 transition-colors", i === line && "bg-accent-tint/60")}>
              <button type="button" onClick={() => seek(l.t)} aria-label={jumpLabel.replace("{time}", clock(l.t))}
                className="w-11 shrink-0 text-left text-sm tabular-nums text-accent hover:underline">{clock(l.t)}</button>
              <span className="min-w-0 max-w-[68ch]">{l.text}</span>
            </p>
          ))}
        </div>
      </section>
    </div>
  );
}
