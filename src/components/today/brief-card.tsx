"use client";
import { useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { Button, Card, CitationChip } from "@/components/ui";
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
    <div className="space-y-1.5 text-sm leading-relaxed">
      {brief.text.split("\n").filter(Boolean).map((line, i) => (
        <p key={i}>
          {splitCitations(line).map((part, j) => {
            if (part.kind === "text") return <span key={j}>{part.text}</span>;
            const c = byN.get(part.n);
            return c ? <CitationChip key={j} n={c.n} title={c.title} confidence={c.confidence} href={citationHref(c)} /> : null;
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

  return (
    <Card className="min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight">
            <Sparkles aria-hidden className="size-4 text-accent" />Today&apos;s brief
          </h2>
          {brief && (
            <p className="mt-0.5 text-xs text-muted">
              {brief.local ? "Checked" : "Written"} at {formatTime(new Date(brief.generatedAt), tz)}
              {brief.model ? ` · ${brief.model}` : ""}
            </p>
          )}
        </div>
        <Button variant={brief ? "secondary" : "primary"} onClick={() => write(Boolean(brief))} disabled={busy} aria-busy={busy}>
          {busy && <Loader2 aria-hidden className="size-4 animate-spin" />}
          {busy ? "Writing…" : brief ? "Write it again" : "Write today's brief"}
        </Button>
      </div>

      <div className="mt-3" aria-live="polite">
        {error && (
          <p role="alert" className="mb-2 rounded-md bg-surface-2 px-3 py-2 text-sm text-warn">{error}</p>
        )}
        {brief ? <BriefText brief={brief} /> : !error && (
          <p className="text-sm text-muted">
            A few lines on what&apos;s coming up — what to pack, sign or book — written from your calendar, reminders and documents,
            with a link to where each point came from.
          </p>
        )}
      </div>
    </Card>
  );
}
