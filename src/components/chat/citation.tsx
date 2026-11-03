"use client";
import { useId } from "react";
import type { Citation } from "@/db/schema";
import { CitationChip } from "@/components/ui";
import { formatLocator } from "@/lib/assistant/context";

export function citationHref(c: Citation): string | undefined {
  if (c.sourceId) return `/library/${c.sourceId}`;
  if (c.nodeId) return `/node/${c.nodeId}`;
  return undefined;
}

/** An inline [n] chip; hovering or focusing it shows the quoted passage. */
export function CitationRef({ citation, compact = true }: { citation: Citation; compact?: boolean }) {
  const tipId = useId();
  const detail = formatLocator(citation.locator) || undefined;
  const hasTip = !!(citation.quote || citation.title);
  const href = citationHref(citation);
  const chip = (
    <CitationChip
      n={citation.n}
      title={compact ? shorten(citation.title, 22) : citation.title}
      detail={compact ? undefined : detail}
      confidence={citation.confidence}
    />
  );
  const label = `Source ${citation.n}: ${citation.title}`;
  return (
    <span className="group relative inline-block max-w-[14rem] align-baseline">
      {href
        ? <a href={href} aria-label={label} aria-describedby={hasTip ? tipId : undefined} className="rounded">{chip}</a>
        : <span tabIndex={0} aria-label={label} aria-describedby={hasTip ? tipId : undefined} className="rounded">{chip}</span>}
      {hasTip && (
        <span
          id={tipId}
          role="tooltip"
          className="pointer-events-none invisible absolute bottom-full left-0 z-20 mb-1 w-72 max-w-[80vw] rounded-md border border-line bg-surface p-3 text-left text-xs font-normal text-fg opacity-0 shadow-lg transition group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100"
        >
          <span className="block font-medium">
            {citation.title}
            {detail && <span className="text-muted"> · {detail}</span>}
          </span>
          {citation.quote && <span className="mt-1 block text-muted">“{shorten(citation.quote, 280)}”</span>}
          {citation.confidence !== undefined && (
            <span className={citation.confidence < 0.6 ? "mt-1 block text-warn" : "mt-1 block text-muted"}>
              Confidence {citation.confidence.toFixed(2)}{citation.confidence < 0.6 ? " · not confirmed" : ""}
            </span>
          )}
        </span>
      )}
    </span>
  );
}

function shorten(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
