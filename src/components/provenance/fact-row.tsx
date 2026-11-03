"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { clsx } from "clsx";
import { Button, NodeChip } from "@/components/ui";
import { ProvenancePanel } from "./provenance-panel";
import { relationLabel, STATUS_LABEL, type ProvenanceView } from "./labels";

export type FactEdge = { id: string; relation: string; status: string; confidence: number };
export type FactEnd = { id: string; label: string; type: string };

/**
 * One fact as a sentence ("Anna · attends · Skolen") with its status, confidence, Confirm / Reject buttons and an
 * expandable "Why do we believe this?" list. Calls PATCH /api/graph/edges/[id] and refreshes the page.
 */
export function FactRow({
  edge, from, to, provenance = [], agents = {}, canEdit = false, onChange,
}: {
  edge: FactEdge;
  from: FactEnd;
  to: FactEnd;
  provenance?: ProvenanceView[];
  agents?: Record<string, string>;
  canEdit?: boolean;
  /** Called with the updated fact; the page is refreshed either way. */
  onChange?: (edge: FactEdge) => void;
}) {
  const router = useRouter();
  const [status, setStatus] = useState(edge.status);
  const [confidence, setConfidence] = useState(edge.confidence);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"confirm" | "reject" | null>(null);
  const [, startTransition] = useTransition();

  async function act(action: "confirm" | "reject") {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(`/api/graph/edges/${edge.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Couldn't save. Please try again.");
      setStatus(data.edge.status);
      setConfidence(data.edge.confidence);
      onChange?.(data.edge);
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  const rejected = status === "rejected";
  return (
    <li className={clsx("rounded-md border border-line bg-surface p-3", rejected && "opacity-60")}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
          <NodeChip type={from.type} label={from.label} href={`/node/${from.id}`} />
          <span className={clsx("text-muted", rejected && "line-through")}>{relationLabel(edge.relation)}</span>
          <NodeChip type={to.type} label={to.label} href={`/node/${to.id}`} />
        </p>
        <span className="flex items-center gap-2 text-xs">
          <StatusBadge status={status} />
          <span className={confidence < 0.6 ? "text-warn" : "text-muted"} title="How sure we are, from 0 to 1">{confidence.toFixed(2)}</span>
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <details className="group min-w-0 flex-1 text-sm">
          <summary className="cursor-pointer select-none text-xs text-accent hover:underline">
            Why do we believe this? ({provenance.length} {provenance.length === 1 ? "record" : "records"})
          </summary>
          <ProvenancePanel items={provenance} agents={agents} title={null} className="mt-2" />
        </details>
        {canEdit && (
          <div className="flex gap-2" role="group" aria-label="Is this fact right?">
            {status !== "confirmed" && (
              <Button variant="secondary" className="px-2 py-1 text-xs" disabled={!!busy} onClick={() => act("confirm")}>
                {busy === "confirm" ? "Saving…" : "Confirm"}
              </Button>
            )}
            {status !== "rejected" && (
              <Button variant="ghost" className="px-2 py-1 text-xs" disabled={!!busy} onClick={() => act("reject")}>
                {busy === "reject" ? "Saving…" : "Reject"}
              </Button>
            )}
          </div>
        )}
      </div>
      <p aria-live="polite" className="text-xs text-danger empty:hidden">{error}</p>
    </li>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={clsx("rounded-full px-2 py-0.5 font-medium",
      status === "confirmed" && "bg-accent-tint text-accent",
      status === "unconfirmed" && "bg-surface-2 text-muted",
      status === "inferred" && "border border-dashed border-inferred text-inferred",
      (status === "rejected" || status === "superseded") && "bg-surface-2 text-danger")}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}
