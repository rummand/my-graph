"use client";
import { useRef } from "react";
import { formatTime } from "@/lib/ingest/chunk";

type Seg = { id: string; text: string; start: number | null; end: number | null };

/** Audio player with a transcript; clicking a timestamp jumps there. */
export function AudioTranscript({ src, title, segments }: { src: string; title: string; segments: Seg[] }) {
  const ref = useRef<HTMLAudioElement>(null);
  return (
    <div className="space-y-4">
      <audio ref={ref} controls preload="metadata" src={src} className="w-full" aria-label={`Play ${title}`} />
      {segments.length > 0 && (
        <ol className="space-y-3">
          {segments.map((s) => (
            <li key={s.id} id={`chunk-${s.id}`} className="flex gap-3 scroll-mt-20">
              {s.start !== null ? (
                <button type="button" className="h-fit shrink-0 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-accent hover:underline"
                  onClick={() => { if (ref.current) { ref.current.currentTime = s.start!; void ref.current.play().catch(() => {}); } }}
                  aria-label={`Play from ${formatTime(s.start)}`}>
                  {formatTime(s.start)}
                </button>
              ) : <span className="w-10 shrink-0" />}
              <p className="min-w-0 whitespace-pre-wrap break-words text-sm">{s.text}</p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
