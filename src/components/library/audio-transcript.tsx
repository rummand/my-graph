"use client";
import { useEffect, useRef, useState } from "react";
import { clsx } from "clsx";
import { formatTime } from "@/lib/ingest/chunk";
import { useProvenance } from "./provenance";

type Seg = { id: string; text: string; start: number | null; end: number | null };

/** Audio player with its transcript. Timestamps and citations play from that moment; the passage playing is marked. */
export function AudioTranscript({ src, title, segments }: { src: string; title: string; segments: Seg[] }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [now, setNow] = useState<number | null>(null);
  const { active } = useProvenance();

  const play = (t: number) => {
    if (!ref.current) return;
    ref.current.currentTime = t;
    void ref.current.play().catch(() => {});
  };

  useEffect(() => {
    if (!active) return;
    const seg = active.chunkId ? segments.find((s) => s.id === active.chunkId) : undefined;
    const t = active.time ?? seg?.start ?? null;
    if (t !== null && t !== undefined) {
      ref.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      play(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- react to a new citation only
  }, [active?.key]);

  const playing = now === null ? null : segments.find((s) => s.start !== null && now >= s.start && (s.end === null || now < s.end))?.id ?? null;

  return (
    <div>
      <div className="bg-surface-2/60 p-4 sm:p-5">
        <audio ref={ref} controls preload="metadata" src={src} className="w-full" aria-label={`Play ${title}`}
          onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)} />
      </div>
      {segments.length > 0 ? (
        <ol className="space-y-1 p-3 sm:p-4">
          {segments.map((s) => {
            const on = playing === s.id || active?.chunkId === s.id;
            return (
              <li key={s.id} id={`chunk-${s.id}`} className={clsx("flex scroll-mt-24 gap-3 rounded-md px-2 py-2 transition-colors duration-200", on && "bg-accent-tint/60")}>
                {s.start !== null ? (
                  <button type="button" onClick={() => play(s.start!)} aria-label={`Play from ${formatTime(s.start)}`}
                    className="h-fit w-12 shrink-0 rounded px-1 py-0.5 text-left text-xs font-medium tabular-nums text-accent hover:bg-accent-tint">
                    {formatTime(s.start)}
                  </button>
                ) : <span className="w-12 shrink-0" />}
                <p className="min-w-0 whitespace-pre-wrap break-words text-[15px] leading-relaxed">{s.text}</p>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="p-5 text-sm text-muted">The transcript appears here once the recording has been read.</p>
      )}
    </div>
  );
}
