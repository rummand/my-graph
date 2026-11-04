"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Maximize2, X } from "lucide-react";
import { renderArtifact, type RenderInput } from "@/lib/artifacts/render";
import { useT } from "@/lib/i18n/client";

export type PreviewProps = Omit<RenderInput, "labels" | "links"> & {
  /** For decks: show one slide at a time with keyboard paging. */
  present?: boolean;
  onExitPresent?: () => void;
  className?: string;
};

export function useRenderLabels() {
  const t = useT();
  return useMemo(() => ({
    sources: t("artifacts.render.sources"), noSources: t("artifacts.render.noSources"), contents: t("artifacts.render.contents"),
    slide: t("artifacts.render.slide"), people: t("artifacts.render.people"), draft: t("artifacts.render.draft"),
  }), [t]);
}

const LINKS: RenderInput["links"] = {
  node: (id) => `/node/${id}`,
  source: (id) => `/library/${id}`,
  image: (id) => `/api/files/${id}`,
};

/**
 * An artifact rendered by the shared renderer with its design set's tokens: the same HTML as print and download.
 * The renderer escapes everything, so the HTML is safe to insert.
 */
export function ArtifactPreview({ present, onExitPresent, className, ...input }: PreviewProps) {
  const t = useT();
  const labels = useRenderLabels();
  const r = useMemo(() => renderArtifact({ ...input, labels, links: LINKS }), [input, labels]);
  const host = useRef<HTMLDivElement>(null);
  const [slide, setSlide] = useState(0);
  const deck = input.kind === "deck";
  const count = deck ? input.content.sections.length + 1 + (input.content.citations.length ? 1 : 0) : 0;

  // Present mode: mark the active slide; arrows, space, PageUp/Down, Home/End page; Escape leaves.
  useEffect(() => {
    const root = host.current?.querySelector<HTMLElement>(`.${r.className}`);
    if (!root || !deck) return;
    if (present) root.setAttribute("data-present", ""); else root.removeAttribute("data-present");
    root.querySelectorAll<HTMLElement>(".a-slide").forEach((el, i) => {
      if (present && i === slide) el.setAttribute("data-active", ""); else el.removeAttribute("data-active");
    });
  }, [r, present, slide, deck]);

  const go = useCallback((d: number) => setSlide((s) => Math.max(0, Math.min(count - 1, s + d))), [count]);
  useEffect(() => {
    if (!present) return;
    const onKey = (e: KeyboardEvent) => {
      const k = e.key;
      if (k === "ArrowRight" || k === "ArrowDown" || k === "PageDown" || k === " ") { e.preventDefault(); go(1); }
      else if (k === "ArrowLeft" || k === "ArrowUp" || k === "PageUp") { e.preventDefault(); go(-1); }
      else if (k === "Home") setSlide(0);
      else if (k === "End") setSlide(count - 1);
      else if (k === "Escape") onExitPresent?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [present, go, count, onExitPresent]);
  useEffect(() => { if (!present) setSlide(0); }, [present]);

  const body = (
    <>
      <link rel="stylesheet" href={r.fontsHref} precedence="default" />
      <style dangerouslySetInnerHTML={{ __html: r.css }} />
      <div ref={host} className={className} dangerouslySetInnerHTML={{ __html: r.html }} />
    </>
  );
  if (!present || !deck) return body;
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={input.title} className="fixed inset-0 z-[60] flex flex-col bg-black/90 p-3 sm:p-6">
      <div className="mb-2 flex items-center justify-between text-sm text-white/70">
        <span className="tabular-nums">{slide + 1} / {count}</span>
        <span className="hidden sm:inline">{t("artifacts.deck.keys")}</span>
        <div className="flex gap-1">
          <button type="button" className="rounded-md p-2 hover:bg-white/10" aria-label={t("artifacts.deck.fullscreen")}
            onClick={() => document.documentElement.requestFullscreen?.().catch(() => {})}><Maximize2 className="size-4" /></button>
          <button type="button" className="rounded-md p-2 hover:bg-white/10" aria-label={t("artifacts.deck.exit")} onClick={onExitPresent}><X className="size-5" /></button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <div className="w-full max-w-[min(100%,calc((100vh-110px)*16/9))]">{body}</div>
      </div>
      <div className="mt-2 flex justify-center gap-2">
        <button type="button" className="rounded-md p-2 text-white/80 hover:bg-white/10 disabled:opacity-30" disabled={slide === 0} aria-label={t("artifacts.deck.prev")} onClick={() => go(-1)}><ChevronLeft className="size-5" /></button>
        <button type="button" className="rounded-md p-2 text-white/80 hover:bg-white/10 disabled:opacity-30" disabled={slide >= count - 1} aria-label={t("artifacts.deck.next")} onClick={() => go(1)}><ChevronRight className="size-5" /></button>
      </div>
    </div>,
    document.body,
  );
}
