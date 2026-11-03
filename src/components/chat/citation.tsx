"use client";
import { useId, useState } from "react";
import { clsx } from "clsx";
import { AnimatePresence, motion } from "motion/react";
import { ChevronDown, FileText, Share2 } from "lucide-react";
import type { Citation } from "@/db/schema";
import { locatorWords } from "./recency";

export function citationHref(c: Citation): string | undefined {
  if (c.sourceId) return `/library/${c.sourceId}`;
  if (c.nodeId) return `/node/${c.nodeId}`;
  return undefined;
}

/** The cobalt number: same family as CitationChip in the UI kit, number only. */
const MARK = "inline-flex h-[1.15rem] min-w-[1.15rem] items-center justify-center rounded-[4px] px-1 text-[11px] font-semibold leading-none tabular-nums";

const isLow = (c: Citation) => c.confidence !== undefined && c.confidence < 0.6;

function whereFrom(c: Citation): string {
  const loc = locatorWords(c.locator);
  if (c.sourceId) return loc ? `Library file, ${loc}` : "Library file";
  if (c.edgeId) return "A link in your graph";
  return "In your graph";
}

function shorten(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

/**
 * The inline mark inside an answer: just the cobalt number, so the sentence stays readable.
 * Hover or focus shows the quoted passage it rests on; click opens the source.
 */
export function CitationRef({ citation }: { citation: Citation }) {
  const tipId = useId();
  const href = citationHref(citation);
  const low = isLow(citation);
  const mark = clsx(
    MARK, "transition-colors",
    low ? "bg-warn-tint text-warn" : "bg-accent-tint text-accent",
    href && (low ? "hover:bg-warn hover:text-white" : "hover:bg-accent hover:text-accent-fg"),
  );
  const label = `Source ${citation.n}: ${citation.title}`;
  return (
    <span className="group/cite relative inline-block align-[0.12em]">
      {href
        ? <a href={href} aria-label={label} aria-describedby={tipId} className={mark}>{citation.n}</a>
        : <span tabIndex={0} aria-label={label} aria-describedby={tipId} className={mark}>{citation.n}</span>}
      <span id={tipId} role="tooltip"
        className="pointer-events-none invisible absolute bottom-[calc(100%+6px)] left-1/2 z-30 w-72 max-w-[78vw] -translate-x-1/2 translate-y-1 rounded-lg bg-surface p-3 text-left text-[13px] font-normal leading-snug text-fg opacity-0 shadow-float transition-[opacity,transform,visibility] duration-150 ease-out group-focus-within/cite:visible group-focus-within/cite:translate-y-0 group-focus-within/cite:opacity-100 group-hover/cite:visible group-hover/cite:translate-y-0 group-hover/cite:opacity-100">
        <span className="block font-medium">{citation.title}</span>
        <span className="mt-0.5 block text-xs text-muted">{whereFrom(citation)}</span>
        {citation.quote && <span className="mt-2 block text-muted">“{shorten(citation.quote, 240)}”</span>}
        {low && <span className="mt-2 block text-xs text-warn">Not confirmed yet ({Math.round(citation.confidence! * 100)}% sure)</span>}
      </span>
    </span>
  );
}

/** The sources an answer rests on, as a short list under it. Long lists fold after three. */
export function SourceList({ citations }: { citations: Citation[] }) {
  const [open, setOpen] = useState(false);
  const FOLD = 3;
  const shown = open ? citations : citations.slice(0, FOLD);
  const hidden = citations.length - FOLD;
  return (
    <div className="mt-5">
      <p className="text-sm font-medium text-muted">{citations.length === 1 ? "Source" : `${citations.length} sources`}</p>
      <ul className="mt-2 space-y-0.5">
        <AnimatePresence initial={false}>
          {shown.map((c) => {
            const href = citationHref(c);
            const Icon = c.sourceId ? FileText : Share2;
            const body = (
              <>
                <span className={clsx(MARK, "shrink-0", isLow(c) ? "bg-warn-tint text-warn" : "bg-accent-tint text-accent")}>{c.n}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-fg">{c.title}</span>
                  {c.quote && <span className="block truncate text-xs text-muted">{c.quote}</span>}
                </span>
                <span className="hidden shrink-0 items-center gap-1 text-xs text-muted sm:inline-flex">
                  <Icon aria-hidden className="size-3.5" />{whereFrom(c)}
                </span>
              </>
            );
            const row = "-mx-2 flex items-center gap-3 rounded-md px-2 py-1.5";
            return (
              <motion.li key={c.n} layout="position"
                initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}>
                {href
                  ? <a href={href} className={clsx(row, "transition-colors hover:bg-surface-2")} title={isLow(c) ? "Not confirmed yet" : undefined}>{body}</a>
                  : <div className={row}>{body}</div>}
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>
      {hidden > 0 && (
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
          className="mt-1 inline-flex items-center gap-1 rounded-md py-1 text-sm text-muted hover:text-fg">
          {open ? "Show fewer" : `Show ${hidden} more`}
          <ChevronDown aria-hidden className={clsx("size-4 transition-transform duration-200", open && "rotate-180")} />
        </button>
      )}
    </div>
  );
}
