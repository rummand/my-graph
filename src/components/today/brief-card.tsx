"use client";
import { useState } from "react";
import { Loader2, RotateCw } from "lucide-react";
import { Button, CitationChip } from "@/components/ui";
import type { Citation } from "@/db/schema";
import type { CachedBrief } from "@/lib/briefs";
import { splitCitations } from "@/lib/briefs/context";
import { formatTime } from "@/lib/briefs/dates";
import { hrefs } from "./section";

function citationHref(c: Citation): string | undefined {
  if (c.nodeId) return hrefs.node(c.nodeId);
  if (c.sourceId) return hrefs.source(c.sourceId);
  return undefined;
}

function BriefText({ brief }: { brief: CachedBrief }) {
  const byN = new Map(brief.citations.map((c) => [c.n, c]));
  return (
    <div className="max-w-[68ch] space-y-2 leading-relaxed">
      {brief.text.split("\n").filter(Boolean).map((line, i) => (
        <p key={i}>
          {splitCitations(line).map((part, j) => {
            if (part.kind === "text") return <span key={j}>{part.text}</span>;
            const c = byN.get(part.n);
            return c ? <span key={j} className="mx-0.5"><CitationChip n={c.n} title={c.title} confidence={c.confidence} href={citationHref(c)} /></span> : null;
          })}
        </p>
      ))}
    </div>
  );
}

/** The daily brief: written on request through mux, cached per user per day on the server. */
export function BriefCard({ initial, tz }: { initial: CachedBrief | null; tz: string }) {
  const [brief, setBrief] = useState<CachedBrief | null>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function write(refresh: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/briefs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh }),
      });
      const body = (await res.json().catch(() => ({}))) as { brief?: CachedBrief; error?: string };
      if (!res.ok || !body.brief) throw new Error(body.error ?? "We couldn't write the brief. Please try again.");
      setBrief(body.brief);
    } catch (err) {
      setError(err instanceof TypeError
        ? "We couldn't reach My Graph. Check your connection and try again."
        : err instanceof Error ? err.message : "We couldn't write the brief. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const when = brief ? formatTime(new Date(brief.generatedAt), tz) : null;

  return (
    <section aria-labelledby="brief-title" className="min-w-0 rounded-lg bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 items-baseline gap-2.5">
          <h2 id="brief-title" className="text-lg font-semibold tracking-[-0.01em]">Today&apos;s brief</h2>
          {brief && (
            <span className="truncate text-sm text-muted">
              {brief.local ? `Checked at ${when}` : `Written at ${when}`}{brief.model ? ` by ${brief.model}` : ""}
            </span>
          )}
        </div>
        {brief ? (
          <Button variant="ghost" size="sm" onClick={() => write(true)} disabled={busy} aria-busy={busy}>
            {busy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <RotateCw aria-hidden className="size-3.5" />}
            {busy ? "Writing…" : "Write it again"}
          </Button>
        ) : (
          <Button onClick={() => write(false)} disabled={busy} aria-busy={busy}>
            {busy && <Loader2 aria-hidden className="size-4 animate-spin" />}
            {busy ? "Writing…" : "Write today's brief"}
          </Button>
        )}
      </div>

      <div className="mt-2.5" aria-live="polite">
        {error && <p role="alert" className="mb-2 rounded-md bg-warn-tint px-3 py-2 text-sm text-warn">{error}</p>}
        {brief ? <BriefText brief={brief} /> : !error && (
          <p className="max-w-[60ch] text-muted">
            A few lines on what&apos;s coming up: what to pack, sign or book, written from your calendar, reminders and
            letters, with a link to where each point came from.
          </p>
        )}
      </div>
    </section>
  );
}
