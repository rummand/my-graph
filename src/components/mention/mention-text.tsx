"use client";
import { Fragment } from "react";
import { parseMentions } from "@/lib/mentions/markup";
import { MentionChip } from "./mention-chip";

/**
 * Plain text that may carry mention markup (`@[Label](node:id)`), rendered with chips. For markdown bodies, run
 * `mentionsToLinks` (./markdown) first instead.
 */
export function MentionText({ text, types }: { text: string; types?: Record<string, string> }) {
  const parts = parseMentions(text);
  if (!parts.length) return <>{text}</>;
  const out: React.ReactNode[] = [];
  let last = 0;
  parts.forEach((m, i) => {
    if (m.start > last) out.push(<Fragment key={`t${i}`}>{text.slice(last, m.start)}</Fragment>);
    out.push(<MentionChip key={`m${i}`} nodeId={m.nodeId} label={m.label} type={types?.[m.nodeId]} />);
    last = m.end;
  });
  if (last < text.length) out.push(<Fragment key="end">{text.slice(last)}</Fragment>);
  return <>{out}</>;
}

/** Markdown: mention markup → ordinary links to the node page (for renderers that don't know mentions). */
export function mentionsToLinks(markdown: string): string {
  return markdown.replace(/@\[([^\]]+)\]\(node:([0-9a-f-]{36})\)/g, (_m, label: string, id: string) => `[${label}](/node/${id})`);
}
