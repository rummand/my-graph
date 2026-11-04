"use client";
/**
 * The waveform (canvas): one bar per few pixels from the peaks, each in the colour of whoever speaks there, full where
 * it has played and pale ahead, with a cobalt cursor. Click or drag to move; arrow keys move 5 s (it is a slider).
 * Without sound, the bars show only where people speak, so the strip still says who spoke when.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { personHue } from "@/lib/ui/person-color";
import { barCount, columns, speakerColumns, speechShape, timeAt, xAt } from "./peaks";
import { clock } from "./timeline-math";

type Line = { a: number; b: number; speaker: string | null };

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function Waveform({ peaks, lines, durationMs, currentMs, colorKey, onSeek, label }: {
  peaks: number[] | null; lines: Line[]; durationMs: number; currentMs: number;
  /** speaker name → the id their colour comes from (their person node, else their name). */
  colorKey: (speaker: string) => string;
  onSeek: (ms: number) => void; label: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const dragging = useRef(false);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !width) return;
    const dpr = window.devicePixelRatio || 1;
    const h = c.clientHeight || 64;
    c.width = Math.round(width * dpr);
    c.height = Math.round(h * dpr);
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, h);
    const n = barCount(width, 3);
    const heights = peaks?.length ? columns(peaks, n) : speechShape(lines, durationMs, n);
    const who = speakerColumns(lines, n, durationMs);
    const s = cssVar("--person-s") || "62%", l = cssVar("--person-l") || "42%";
    const ts = cssVar("--person-tint-s") || "70%", tl = cssVar("--person-tint-l") || "85%";
    const muted = cssVar("--muted") || "#5B6660", line = cssVar("--line") || "#DCE0DA";
    const playedX = xAt(currentMs, width, durationMs);
    const pitch = width / n;
    const bar = Math.max(1, pitch - 1);
    for (let i = 0; i < n; i++) {
      const x = i * pitch;
      const bh = Math.max(2, heights[i] * (h - 4));
      const sp = who[i];
      const played = x + bar / 2 <= playedX;
      if (sp) {
        const hue = personHue(colorKey(sp));
        ctx.fillStyle = played ? `hsl(${hue} ${s} ${l})` : `hsl(${hue} ${ts} ${tl})`;
      } else ctx.fillStyle = played ? muted : line;
      const y = (h - bh) / 2;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, bar, bh, Math.min(1.5, bar / 2));
      else ctx.rect(x, y, bar, bh);
      ctx.fill();
    }
    ctx.fillStyle = cssVar("--accent") || "#2F4BB0";
    ctx.fillRect(Math.min(width - 2, Math.max(0, playedX - 1)), 0, 2, h);
  }, [width, peaks, lines, durationMs, currentMs, colorKey]);

  const msAt = useCallback((clientX: number) => {
    const r = wrap.current!.getBoundingClientRect();
    return timeAt(clientX - r.left, r.width, durationMs);
  }, [durationMs]);

  return (
    <div ref={wrap} className="relative w-full select-none">
      <canvas ref={canvas} className="block h-16 w-full cursor-pointer touch-none rounded-md sm:h-20"
        role="slider" tabIndex={0} aria-label={label} aria-valuemin={0} aria-valuemax={Math.round(durationMs / 1000)}
        aria-valuenow={Math.round(currentMs / 1000)} aria-valuetext={`${clock(currentMs)} / ${clock(durationMs)}`}
        onPointerDown={(e) => { dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); onSeek(msAt(e.clientX)); }}
        onPointerMove={(e) => { setHover(msAt(e.clientX)); if (dragging.current) onSeek(msAt(e.clientX)); }}
        onPointerUp={(e) => { dragging.current = false; e.currentTarget.releasePointerCapture(e.pointerId); }}
        onPointerLeave={() => setHover(null)}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); onSeek(Math.min(durationMs, Math.max(0, currentMs + (e.key === "ArrowLeft" ? -5000 : 5000)))); }
          if (e.key === "Home") { e.preventDefault(); onSeek(0); }
          if (e.key === "End") { e.preventDefault(); onSeek(durationMs); }
        }} />
      {hover !== null && width > 0 && (
        <span className="pointer-events-none absolute -top-6 -translate-x-1/2 rounded bg-fg px-1.5 py-0.5 text-xs tabular-nums text-bg"
          style={{ left: xAt(hover, width, durationMs) }}>{clock(hover)}</span>
      )}
    </div>
  );
}
