"use client";
import { Fragment, useMemo, type ReactNode } from "react";
import type { Citation } from "@/db/schema";
import { parseMarkdown, type Inline } from "@/lib/assistant/markdown";
import { CitationRef } from "./citation";

/** Renders the safe markdown subset as React elements (no HTML strings anywhere). */
export function Markdown({ text, citations }: { text: string; citations: Citation[] }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  const byN = useMemo(() => new Map(citations.map((c) => [c.n, c])), [citations]);
  return (
    <div className="space-y-3 break-words leading-relaxed">
      {blocks.map((b, i) => {
        if (b.t === "p") return <p key={i}>{inlines(b.c, byN)}</p>;
        if (b.t === "h") return <p key={i} className="font-semibold">{inlines(b.c, byN)}</p>;
        if (b.t === "ul") return <ul key={i} className="list-disc space-y-1 pl-5">{b.items.map((it, j) => <li key={j}>{inlines(it, byN)}</li>)}</ul>;
        return <ol key={i} start={b.start} className="list-decimal space-y-1 pl-5">{b.items.map((it, j) => <li key={j}>{inlines(it, byN)}</li>)}</ol>;
      })}
    </div>
  );
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
          <span key={i} className="mx-0.5 inline-flex flex-wrap gap-0.5 align-baseline">
            {x.ns.map((n) => {
              const c = byN.get(n);
              return c ? <CitationRef key={n} citation={c} /> : <span key={n} className="font-mono text-[11px] text-muted">[{n}]</span>;
            })}
          </span>
        );
    }
  });
}
