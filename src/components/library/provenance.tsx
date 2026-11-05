"use client";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { clsx } from "clsx";
import { CitationChip } from "@/components/ui";
import { useT } from "@/lib/i18n/client";

/**
 * "Provenance you can touch" on a file's page: pressing a fact's citation marks the exact words in the original
 * (or turns the PDF to its page, or plays the recording from that moment).
 */
export type Target = {
  key: string;
  quote?: string | null;
  chunkId?: string | null;
  page?: number;
  time?: number;
  charStart?: number;
  charEnd?: number;
};

type Ctx = { active: Target | null; show: (t: Target) => void };
const ProvenanceCtx = createContext<Ctx>({ active: null, show: () => {} });
export const useProvenance = () => useContext(ProvenanceCtx);

/**
 * "#chunk-<id>[.p3][.q<words>]" (a search result: its passage, the PDF page, the words that matched) → a target to
 * show, so opening a result marks the words in the original.
 */
export function targetFromHash(hash: string): Target | null {
  const m = hash.match(/^#chunk-([0-9a-f-]{36})(?:\.p(\d{1,4}))?(?:\.q(.{1,200}))?$/i);
  if (!m) return null;
  let quote: string | null = null;
  try { quote = m[3] ? decodeURIComponent(m[3]) : null; } catch { quote = null; }
  return { key: `hash:${m[1]}`, chunkId: m[1], page: m[2] ? Number(m[2]) : undefined, quote };
}

export function ProvenanceProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<Target | null>(null);
  // Opened from search: mark the passage (and turn the PDF to its page) named in the address.
  useEffect(() => {
    const read = () => { const t = targetFromHash(window.location.hash); if (t) setActive({ ...t, key: `${t.key}:${Date.now()}` }); };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  const value = useMemo<Ctx>(() => ({ active, show: (t) => setActive({ ...t, key: `${t.key}:${Date.now()}` }) }), [active]);
  return <ProvenanceCtx.Provider value={value}>{children}</ProvenanceCtx.Provider>;
}

/** A cobalt citation that shows where in the original a fact was read. */
export function CiteButton({ target, title, confidence }: { target: Omit<Target, "key"> & { key: string }; title: string; confidence?: number }) {
  const { show } = useProvenance();
  const t = useT();
  return (
    <button type="button" onClick={() => show(target)} className="rounded-[4px] align-baseline [&>span]:hover:bg-accent [&>span]:hover:text-accent-fg"
      aria-label={t("library.detail.showWhere", { title })}>
      <CitationChip title={title} confidence={confidence} />
    </button>
  );
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** Find a quote in a text, tolerating differences in spacing and case. Returns [start, end) or null. */
export function findQuote(text: string, quote: string): [number, number] | null {
  if (!quote.trim()) return null;
  const exact = text.indexOf(quote);
  if (exact >= 0) return [exact, exact + quote.length];
  // Map normalised positions back to the original text.
  const map: number[] = [];
  let out = "";
  let lastSpace = true;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (/\s/.test(c)) {
      if (!lastSpace) { out += " "; map.push(i); }
      lastSpace = true;
    } else {
      out += c.toLowerCase();
      map.push(i);
      lastSpace = false;
    }
  }
  const q = norm(quote);
  const at = out.indexOf(q);
  if (at < 0) return null;
  return [map[at], map[at + q.length - 1] + 1];
}

/** Text shown with the cited words marked. Scrolls the mark into view when a citation is pressed. */
export function MarkedText({ text, className, rangeFromLocator = false }: { text: string; className?: string; rangeFromLocator?: boolean }) {
  const { active } = useProvenance();
  const ref = useRef<HTMLElement>(null);
  const range = useMemo(() => {
    if (!active) return null;
    if (active.quote) {
      const r = findQuote(text, active.quote);
      if (r) return r;
    }
    if (rangeFromLocator && active.charStart !== undefined && active.charEnd !== undefined && active.charEnd <= text.length + 5) {
      return [active.charStart, Math.min(active.charEnd, text.length)] as [number, number];
    }
    return null;
  }, [active, text, rangeFromLocator]);

  useEffect(() => {
    if (range && ref.current) ref.current.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [range, active?.key]);

  if (!range) return <p className={className}>{text}</p>;
  return (
    <p className={className}>
      {text.slice(0, range[0])}
      <mark key={active?.key} ref={ref} className="animate-[cite_900ms_ease-out] rounded-[3px] bg-accent-tint px-0.5 text-fg ring-1 ring-accent/30">{text.slice(range[0], range[1])}</mark>
      {text.slice(range[1])}
      <style>{"@keyframes cite{0%{background:var(--accent);color:var(--accent-fg)}100%{background:var(--accent-tint)}}"}</style>
    </p>
  );
}

/** Passages read from a file (OCR, PDF pages, extracted text), each addressable by a citation. */
export function PassageList({ chunks, labelFor }: { chunks: { id: string; text: string; label: string }[]; labelFor?: string }) {
  const { active } = useProvenance();
  const refs = useRef(new Map<string, HTMLLIElement>());
  useEffect(() => {
    if (!active?.chunkId) return;
    refs.current.get(active.chunkId)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [active]);
  return (
    <ol aria-label={labelFor} className="space-y-5">
      {chunks.map((c) => {
        const on = active?.chunkId === c.id;
        return (
          <li key={c.id} id={`chunk-${c.id}`} ref={(el) => { if (el) refs.current.set(c.id, el); else refs.current.delete(c.id); }}
            className={clsx("scroll-mt-24 rounded-md transition-colors duration-200", on && "bg-accent-tint/50 -mx-3 px-3 py-2")}>
            <p className="mb-1 text-xs tabular-nums text-muted">{c.label}</p>
            {on ? <MarkedText text={c.text} className="whitespace-pre-wrap break-words text-sm leading-relaxed" />
              : <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{c.text}</p>}
          </li>
        );
      })}
    </ol>
  );
}

/** The PDF itself; a citation with a page turns to that page. */
export function PdfFrame({ url, title }: { url: string; title: string }) {
  const { active } = useProvenance();
  const ref = useRef<HTMLIFrameElement>(null);
  const page = active?.page;
  const t = useT();
  useEffect(() => {
    if (page) ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [page, active?.key]);
  return <iframe ref={ref} key={page ?? 0} src={page ? `${url}#page=${page}` : url} title={t("library.detail.pdfFrame", { title })} className="block h-[78vh] min-h-[420px] w-full bg-surface-2" />;
}
