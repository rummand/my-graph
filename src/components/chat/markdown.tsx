"use client";
import { Fragment, useMemo, type ReactNode } from "react";
import type { Citation } from "@/db/schema";
import { parseMarkdown, type Inline } from "@/lib/assistant/markdown";
import { CitationRef } from "./citation";

/** Renders the safe markdown subset as React elements (no HTML strings anywhere). */
export function Markdown({ text, citations, caret = false }: { text: string; citations: Citation[]; caret?: boolean }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  const byN = useMemo(() => new Map(citations.map((c) => [c.n, c])), [citations]);
  const last = blocks.length - 1;
  const tail = (i: number) => (caret && i === last ? <Caret /> : null);
  return (
    <div className="space-y-4 break-words text-[15.5px] leading-[1.7] [&_li]:pl-1 [&_li::marker]:text-muted">
      {blocks.map((b, i) => {
        if (b.t === "p") return <p key={i}>{inlines(b.c, byN)}{tail(i)}</p>;
        if (b.t === "h") return <h3 key={i} className="pt-1 font-semibold">{inlines(b.c, byN)}{tail(i)}</h3>;
        if (b.t === "ul") return <ul key={i} className="list-disc space-y-2 pl-5">{b.items.map((it, j) => <li key={j}>{inlines(it, byN)}{j === b.items.length - 1 && tail(i)}</li>)}</ul>;
        return <ol key={i} start={b.start} className="list-decimal space-y-2 pl-5">{b.items.map((it, j) => <li key={j}>{inlines(it, byN)}{j === b.items.length - 1 && tail(i)}</li>)}</ol>;
      })}
      {caret && blocks.length === 0 && <p><Caret /></p>}
    </div>
  );
}

/** A soft ink caret at the end of a streaming answer: it shows the answer is still being written. */
function Caret() {
  return <span aria-hidden className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[0.18em] animate-pulse rounded-full bg-fg/60" />;
}

function inlines(list: Inline[], byN: Map<number, Citation>): ReactNode {
  return list.map((x, i) => {
    switch (x.t) {
      case "text": return <Fragment key={i}>{x.v}</Fragment>;
      case "br": return <br key={i} />;
      case "bold": return <strong key={i} className="font-semibold">{inlines(x.c, byN)}</strong>;
      case "em": return <em key={i}>{inlines(x.c, byN)}</em>;
      case "code": return <code key={i} className="rounded bg-surface-2 px-1 font-mono text-[0.85em]">{x.v}</code>;
      case "cite":
        return (
          <span key={i} className="inline-flex gap-0.5 whitespace-nowrap">
            {x.ns.map((n) => {
              const c = byN.get(n);
              return c ? <CitationRef key={n} citation={c} /> : <span key={n} className="text-xs tabular-nums text-muted">[{n}]</span>;
            })}
          </span>
        );
    }
  });
}
