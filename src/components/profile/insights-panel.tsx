"use client";
/**
 * "How they've been doing": a sourced timeline of what the person said or what was noted about stress, health, mood
 * and events, what matters to them, and what to follow up on. Only the viewer sees it; every line links to its
 * evidence. Generated on demand (POST /api/profile/:id/insights) and kept until regenerated.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { Lock, RefreshCw, Sparkles } from "lucide-react";
import { clsx } from "clsx";
import { Badge, Button } from "@/components/ui";
import { useFormatDate, useT } from "@/lib/i18n/client";
import type { Evidence, InsightsView } from "@/lib/profile/types";

const AREA_TONE: Record<string, "warn" | "danger" | "accent" | "neutral" | "inferred"> = {
  stress: "warn", health: "danger", mood: "inferred", event: "accent", school: "neutral", work: "neutral", relationships: "neutral", other: "neutral",
};

function Cites({ ids, evidence }: { ids: string[]; evidence: Map<string, Evidence> }) {
  const t = useT();
  return (
    <span className="ml-1 inline-flex flex-wrap gap-1 align-baseline">
      {ids.map((id) => {
        const e = evidence.get(id);
        if (!e) return null;
        const n = Number(id.slice(1));
        return (
          <Link key={id} href={e.href} title={`${e.title}: ${e.text}`} aria-label={t("profile.insights.evidence", { title: e.title })}
            className="rounded-full bg-accent-tint px-1.5 text-xs tabular-nums text-accent hover:underline">{n}</Link>
        );
      })}
    </span>
  );
}

export function InsightsPanel({ nodeId, name }: { nodeId: string; name: string }) {
  const t = useT();
  const fmt = useFormatDate();
  const [view, setView] = useState<InsightsView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = name.split(" ")[0];

  useEffect(() => {
    let live = true;
    fetch(`/api/profile/${nodeId}/insights`).then((r) => (r.ok ? r.json() : null)).then((d) => { if (live) setView(d); }).catch(() => live && setView(null));
    return () => { live = false; };
  }, [nodeId]);

  const generate = async () => {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/profile/${nodeId}/insights`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.muxDown ? t("profile.insights.muxDown") : data.error ?? t("profile.insights.failed")); return; }
      setView(data);
    } catch { setError(t("profile.insights.failed")); } finally { setBusy(false); }
  };

  if (!view || view.status === "off") return null;
  const evidence = new Map(view.evidence.map((e) => [e.id, e]));
  const ins = view.insights;
  const nothing = ins && !ins.timeline.length && !ins.matters.length && !ins.followUps.length;

  return (
    <section aria-labelledby="insights-h" className="min-w-0">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="insights-h" className="text-lg font-semibold tracking-[-0.01em]">{t("profile.insights.title", { name: first })}</h2>
          <p className="mt-0.5 inline-flex items-center gap-1.5 text-xs text-muted"><Lock aria-hidden className="size-3" />{t("profile.insights.private")}</p>
        </div>
        {view.status !== "empty" && (
          <Button variant={ins ? "secondary" : "primary"} size="sm" onClick={generate} disabled={busy}>
            {ins ? <RefreshCw aria-hidden className={clsx("size-4", busy && "animate-spin")} /> : <Sparkles aria-hidden className="size-4" />}
            {busy ? t("profile.insights.reading") : ins ? t("profile.insights.regenerate") : t("profile.insights.generate")}
          </Button>
        )}
      </div>
      <div className="rounded-lg bg-surface p-4 sm:p-5">
        {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}
        {view.status === "empty" && <p className="text-sm text-muted">{t("profile.insights.empty", { name: first })}</p>}
        {view.status === "mux_down" && !ins && <p className="text-sm text-muted">{t("profile.insights.muxDown")}</p>}
        {view.status === "none" && !ins && <p className="text-sm text-muted">{t("profile.insights.none", { name: first })}</p>}
        {ins && (
          <div className="space-y-6">
            {view.stale && <p className="text-sm text-warn">{t("profile.insights.stale")}</p>}
            {nothing && <p className="text-sm text-muted">{t("profile.insights.nothing", { name: first })}</p>}
            {ins.timeline.length > 0 && (
              <ol className="space-y-3">
                {ins.timeline.map((l, i) => (
                  <li key={i} className="grid grid-cols-[84px_minmax(0,1fr)] gap-3 text-[15px]">
                    <span className="pt-0.5 text-xs tabular-nums text-muted" suppressHydrationWarning>{l.at ? fmt(`${l.at}T12:00:00Z`, "date") : t("profile.insights.undated")}</span>
                    <p className="min-w-0">
                      <Badge tone={AREA_TONE[l.area] ?? "neutral"} className="mr-2 align-[1px]">{t(`profile.insights.area.${l.area}`)}</Badge>
                      {l.text}<Cites ids={l.evidence} evidence={evidence} />
                    </p>
                  </li>
                ))}
              </ol>
            )}
            {ins.matters.length > 0 && (
              <div>
                <h3 className="mb-1.5 text-sm font-medium">{t("profile.insights.matters", { name: first })}</h3>
                <ul className="list-disc space-y-1 pl-5 text-[15px]">{ins.matters.map((m, i) => <li key={i}>{m.text}<Cites ids={m.evidence} evidence={evidence} /></li>)}</ul>
              </div>
            )}
            {ins.followUps.length > 0 && (
              <div>
                <h3 className="mb-1.5 text-sm font-medium">{t("profile.insights.followUps")}</h3>
                <ul className="list-disc space-y-1 pl-5 text-[15px]">{ins.followUps.map((m, i) => <li key={i}>{m.text}<Cites ids={m.evidence} evidence={evidence} /></li>)}</ul>
              </div>
            )}
            <p className="text-xs text-muted" suppressHydrationWarning>
              {t("profile.insights.footer", { count: view.evidence.length, when: view.generatedAt ? fmt(view.generatedAt, "dateTime") : "" })}
              {view.dropped > 0 && <> {t("profile.insights.dropped", { count: view.dropped })}</>}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
