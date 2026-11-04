"use client";
/**
 * The transcript, read along: each turn under its speaker (in their colour), every word clickable to jump there, and
 * a cobalt marker (the "finger") under the word being said, gliding from word to word. The current line stays in
 * view; scrolling yourself pauses that until "Back to the playing moment". Search marks matching words and steps
 * through the lines that hold them.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { clsx } from "clsx";
import { ChevronDown, ChevronUp, Search, Undo2 } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { personStyle } from "@/lib/ui/person-color";
import { clock, searchLines, wordMatches, type Line, type Word } from "./timeline-math";

type Props = {
  words: Word[]; lines: Line[]; current: number; playing: boolean;
  colorKey: (speaker: string) => string;
  onJump: (ms: number) => void;
  searchRef?: React.RefObject<HTMLInputElement | null>;
  className?: string;
};

const LineView = memo(function LineView({ line, index, words, current, query, colorKey, onJump, showSpeaker }: {
  line: Line; index: number; words: Word[]; current: number; query: string; colorKey: (s: string) => string; onJump: (ms: number) => void; showSpeaker: boolean;
}) {
  const t = useT();
  const inLine = current >= line.first && current <= line.last;
  const style = line.speaker ? (personStyle(colorKey(line.speaker)) as CSSProperties) : undefined;
  const ws = words.slice(line.first, line.last + 1);
  return (
    <div data-line={index} className="rounded-md px-2 py-1.5" style={style}>
      {showSpeaker && (
        <div className="mb-0.5 flex items-baseline gap-2">
          <span className="inline-flex items-center gap-1.5 text-sm font-semibold" style={{ color: line.speaker ? "var(--person-ink)" : undefined }}>
            {line.speaker && <span aria-hidden className="size-2 rounded-full" style={{ background: "var(--person)" }} />}
            {line.speaker ?? ""}
          </span>
          <button type="button" onClick={() => onJump(line.a)} className="text-xs tabular-nums text-muted hover:text-accent" title={t("recordings.transcript.jump", { time: clock(line.a) })}>
            {clock(line.a)}
          </button>
        </div>
      )}
      <p className={clsx("text-[15px] leading-7", line.speaker && "border-l-2 pl-3")} style={line.speaker ? { borderColor: "var(--person-tint)" } : undefined}>
        {ws.length ? ws.map((w, k) => {
          const i = line.first + k;
          const hit = query && wordMatches(w.w, query);
          return (
            <span key={i}>
              <span data-w={i} role="button" tabIndex={-1} onClick={() => onJump(w.a)}
                className={clsx("cursor-pointer rounded-sm transition-colors hover:text-accent",
                  inLine && i > current && "text-muted",
                  hit && "bg-warn-tint text-fg")}>
                {w.w}
              </span>{" "}
            </span>
          );
        }) : line.text}
      </p>
    </div>
  );
});

export function Transcript({ words, lines, current, playing, colorKey, onJump, searchRef, className }: Props) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const finger = useRef<HTMLSpanElement>(null);
  const [follow, setFollow] = useState(true);
  const [query, setQuery] = useState("");
  const [hit, setHit] = useState(0);
  const jumped = useRef(false);
  const hits = useMemo(() => searchLines(lines, query), [lines, query]);
  const currentLine = current >= 0 ? words[current]?.line ?? -1 : -1;

  // The finger: a marker under the current word, moved (not re-rendered) so it glides.
  useLayoutEffect(() => {
    const f = finger.current, b = box.current;
    if (!f || !b) return;
    const el = current >= 0 ? b.querySelector<HTMLElement>(`[data-w="${current}"]`) : null;
    if (!el) { f.style.opacity = "0"; return; }
    const br = b.getBoundingClientRect(), r = el.getBoundingClientRect();
    f.style.opacity = "1";
    f.style.transform = `translate(${r.left - br.left + b.scrollLeft - 3}px, ${r.top - br.top + b.scrollTop - 1}px)`;
    f.style.width = `${r.width + 6}px`;
    f.style.height = `${r.height + 2}px`;
  }, [current, query]);

  // Keep the playing line in view (a third from the top), unless the person scrolled away.
  useEffect(() => {
    if (!follow || currentLine < 0 || !box.current) return;
    const el = box.current.querySelector<HTMLElement>(`[data-line="${currentLine}"]`);
    if (!el) return;
    const b = box.current;
    const top = el.offsetTop - b.clientHeight / 3;
    if (Math.abs(b.scrollTop - top) > 8 && (el.offsetTop < b.scrollTop + 24 || el.offsetTop + el.offsetHeight > b.scrollTop + b.clientHeight - 24 || playing)) {
      b.scrollTo({ top: Math.max(0, top), behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    }
  }, [currentLine, follow, playing]);

  const goHit = useCallback((i: number) => {
    if (!hits.length) return;
    const n = ((i % hits.length) + hits.length) % hits.length;
    setHit(n);
    jumped.current = true;
    setFollow(false);
    const el = box.current?.querySelector<HTMLElement>(`[data-line="${hits[n]}"]`);
    if (el && box.current) box.current.scrollTo({ top: Math.max(0, el.offsetTop - 80), behavior: "smooth" });
  }, [hits]);

  const userScrolled = () => setFollow(false);

  if (!lines.length) return <p className="text-sm text-muted">{t("recordings.transcript.empty")}</p>;
  return (
    <div className={clsx("relative", className)}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">{t("recordings.transcript.searchLabel")}</span>
          <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <input ref={searchRef} type="search" value={query} placeholder={t("recordings.transcript.searchPlaceholder")}
            onChange={(e) => { setQuery(e.target.value); setHit(0); jumped.current = false; }}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); goHit(!jumped.current ? 0 : e.shiftKey ? hit - 1 : hit + 1); }
              if (e.key === "Escape") setQuery("");
            }}
            className="h-9 w-full rounded-md border border-line bg-surface pl-8 pr-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent" />
        </label>
        {query && (
          <span className="flex items-center gap-1 text-sm text-muted" role="status">
            <span className="tabular-nums">{hits.length ? `${hit + 1}/${hits.length}` : t("recordings.transcript.hits", { count: 0 })}</span>
            <button type="button" className="rounded-md p-1 hover:bg-surface-2 disabled:opacity-40" disabled={!hits.length} onClick={() => goHit(hit - 1)} aria-label={t("recordings.transcript.prev")}><ChevronUp className="size-4" /></button>
            <button type="button" className="rounded-md p-1 hover:bg-surface-2 disabled:opacity-40" disabled={!hits.length} onClick={() => goHit(hit + 1)} aria-label={t("recordings.transcript.next")}><ChevronDown className="size-4" /></button>
          </span>
        )}
      </div>
      <div ref={box} onWheel={userScrolled} onTouchMove={userScrolled}
        onKeyDown={(e) => { if (["PageUp", "PageDown", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) userScrolled(); }}
        className="relative max-h-[60vh] overflow-y-auto overscroll-contain pr-1 lg:max-h-[68vh]" tabIndex={0} aria-label={t("recordings.transcript.title")}>
        <span ref={finger} aria-hidden className="pointer-events-none absolute left-0 top-0 rounded-[5px] bg-accent-tint opacity-0 ring-1 ring-accent/40 transition-[transform,width,height,opacity] duration-150 ease-out motion-reduce:transition-none" />
        <div className="relative space-y-1">
          {lines.map((l, i) => (
            <LineView key={i} line={l} index={i} words={words} current={currentLine === i ? current : -1} query={query} colorKey={colorKey} onJump={onJump}
              showSpeaker={i === 0 || lines[i - 1].speaker !== l.speaker || l.a - lines[i - 1].b > 30_000} />
          ))}
        </div>
      </div>
      {!follow && currentLine >= 0 && (
        <button type="button" onClick={() => setFollow(true)}
          className="absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-fg px-3 py-1.5 text-sm font-medium text-bg shadow-float">
          <Undo2 aria-hidden className="size-4" />{t("recordings.transcript.follow")}
        </button>
      )}
    </div>
  );
}
