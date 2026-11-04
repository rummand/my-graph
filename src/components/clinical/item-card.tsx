"use client";
/**
 * One clinical item to check: a suggestion (code, medication, lab value, theme, hypothesis, follow-up) with the words it
 * was read from, and the clinician's decision. Risk flags use the same card in brick. Versions open underneath.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { clsx } from "clsx";
import { AlertTriangle, Check, History, Quote, X } from "lucide-react";
import { Badge, Button } from "@/components/ui";
import { useFormatDate, useT } from "@/lib/i18n/client";
import type { ItemView, RevisionView } from "@/lib/clinical/items";
import { call } from "./api";

export function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** The decision buttons an item offers in its state (only for the clinician). */
export function actionsFor(item: Pick<ItemView, "kind" | "status">): ("confirm" | "dismiss" | "acknowledge" | "reopen" | "complete")[] {
  if (item.kind === "risk") return item.status === "open" ? ["acknowledge"] : [];
  if (item.kind === "followup") return item.status === "proposed" ? ["confirm", "dismiss"] : item.status === "confirmed" ? ["complete"] : [];
  if (item.kind === "summary" || item.kind === "note" || item.kind === "letter") return item.status === "proposed" ? ["dismiss"] : [];
  if (item.status === "proposed") return ["confirm", "dismiss"];
  if (item.status === "dismissed") return ["reopen"];
  return [];
}

export function Evidence({ item, compact }: { item: ItemView; compact?: boolean }) {
  const t = useT();
  if (!item.evidence.length) return null;
  return (
    <ul className={clsx("space-y-1", compact ? "mt-1" : "mt-2")}>
      {item.evidence.slice(0, compact ? 1 : 5).map((e, i) => e.quote && (
        <li key={i} className="flex gap-2 text-sm text-muted">
          <Quote aria-hidden className="mt-0.5 size-3.5 shrink-0 text-accent" />
          <span className="min-w-0">
            <span className="font-read italic text-fg/85">“{e.quote}”</span>
            {e.timeSec != null && <span className="ml-1.5 text-xs tabular-nums">{t("clinical.item.atTime", { time: fmtTime(e.timeSec) })}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Versions({ id }: { id: string }) {
  const t = useT();
  const fmt = useFormatDate();
  const [rows, setRows] = useState<RevisionView[] | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2">
      <button type="button" className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg" aria-expanded={open}
        onClick={async () => { setOpen(!open); if (!rows) setRows((await call<{ revisions: RevisionView[] }>(`/api/clinical/items/${id}/history`)).data?.revisions ?? []); }}>
        <History aria-hidden className="size-3.5" />{t("clinical.item.history")}
      </button>
      {open && rows && (
        <ol className="mt-1.5 space-y-0.5 border-l border-line pl-3 text-xs text-muted">
          {rows.map((r) => <li key={r.id}><span className="tabular-nums">{fmt(r.at, "dateTime")}</span>: {t(`clinical.item.revision.${r.action}`, { name: r.actorName ?? "" })}</li>)}
        </ol>
      )}
    </div>
  );
}

export function useDecide() {
  const router = useRouter();
  const t = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function decide(id: string, decision: string, extra: Record<string, unknown> = {}): Promise<boolean> {
    setBusy(id); setError(null);
    const r = await call(`/api/clinical/items/${id}/decide`, { body: { decision, ...extra } }, t("clinical.err.offline"));
    setBusy(null);
    if (r.error) { setError(r.error); return false; }
    router.refresh();
    return true;
  }
  return { decide, busy, error, setError };
}

export function ItemCard({ item, canDecide, title, detail, children }: { item: ItemView; canDecide: boolean; title: string; detail?: string | null; children?: React.ReactNode }) {
  const t = useT();
  const { decide, busy, error } = useDecide();
  const risk = item.kind === "risk";
  const muted = item.status === "dismissed";
  return (
    <li className={clsx("rounded-lg p-3.5", risk && item.status === "open" ? "bg-danger-tint" : "bg-surface", muted && "opacity-60")}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className={clsx("flex flex-wrap items-center gap-2 font-medium", risk && item.status === "open" && "text-danger")}>
            {risk && <AlertTriangle aria-hidden className="size-4" />}
            <span className={clsx(muted && "line-through")}>{title}</span>
            {item.kind === "hypothesis" && <Badge tone="inferred">{t("clinical.item.hypothesisLabel")}</Badge>}
            {item.status !== "proposed" && item.status !== "open" && <Badge tone={item.status === "confirmed" || item.status === "signed" ? "accent" : "neutral"}>{t(`clinical.item.status.${item.status}`)}</Badge>}
          </p>
          {detail && <p className="mt-0.5 text-sm text-muted">{detail}</p>}
          <Evidence item={item} />
          {children}
          {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
          <Versions id={item.id} />
        </div>
        {canDecide && (
          <div className="flex shrink-0 gap-1.5">
            {actionsFor(item).map((a) => (
              <Button key={a} size="sm" variant={a === "confirm" || a === "acknowledge" || a === "complete" ? "secondary" : "ghost"} disabled={busy === item.id}
                onClick={() => decide(item.id, a, { baseVersion: item.version })}>
                {a === "confirm" || a === "complete" ? <Check aria-hidden className="size-3.5" /> : a === "dismiss" ? <X aria-hidden className="size-3.5" /> : null}
                {t(`clinical.item.${a}`)}
              </Button>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}
