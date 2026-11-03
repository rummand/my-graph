"use client";
import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { clsx } from "clsx";
import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronDown, X } from "lucide-react";
import { Button } from "@/components/ui";
import { NodePill } from "@/components/graph/node-mark";
import { ProvenancePanel } from "./provenance-panel";
import { percentSure, relationLabel, STATUS_LABEL, type ProvenanceView } from "./labels";

export type FactEdge = { id: string; relation: string; status: string; confidence: number };
export type FactEnd = { id: string; label: string; type: string };

/**
 * One fact with its evidence. Shown from one node's point of view (`subjectId` set) it names only the other end,
 * since the relation is the group heading; otherwise it reads as a sentence ("Anna parent of Emma").
 * The cobalt numbers open "Why do we believe this?". Confirm / This is wrong call PATCH /api/graph/edges/[id].
 */
export function FactRow({
  edge, from, to, provenance = [], agents = {}, canEdit = false, onChange, subjectId, label,
}: {
  edge: FactEdge;
  from: FactEnd;
  to: FactEnd;
  provenance?: ProvenanceView[];
  agents?: Record<string, string>;
  canEdit?: boolean;
  /** Called with the updated fact; the page is refreshed either way. */
  onChange?: (edge: FactEdge) => void;
  /** The node whose page this row sits on. */
  subjectId?: string;
  /** The relation as read in this row's direction, e.g. "child of". */
  label?: string;
}) {
  const router = useRouter();
  const panelId = useId();
  const [status, setStatus] = useState(edge.status);
  const [confidence, setConfidence] = useState(edge.confidence);
  const [open, setOpen] = useState(false);
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

  const rejected = status === "rejected" || status === "superseded";
  const needsCheck = status === "unconfirmed" || status === "inferred";
  const other = subjectId ? (from.id === subjectId ? to : from) : null;
  const low = confidence < 0.6;
  const quote = provenance.find((p) => p.quote)?.quote ?? null;

  return (
    <li className={clsx("group/fact px-4 py-3 transition-opacity", rejected && "opacity-55")}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {other ? (
            <NodePill id={other.id} type={other.type} label={other.label} href={`/node/${other.id}`}
              className={clsx(rejected && "line-through", status === "inferred" && "outline-1 outline-dashed outline-inferred/60")} />
          ) : (
            <>
              <NodePill id={from.id} type={from.type} label={from.label} href={`/node/${from.id}`} />
              <span className={clsx("text-sm text-muted", rejected && "line-through")}>{label ?? relationLabel(edge.relation)}</span>
              <NodePill id={to.id} type={to.type} label={to.label} href={`/node/${to.id}`} />
            </>
          )}
          {status !== "confirmed" && <StatusBadge status={status} />}
          {other && quote && (
            <span className="ml-1.5 hidden min-w-0 flex-1 truncate text-sm text-muted md:block" title={quote}>&ldquo;{quote}&rdquo;</span>
          )}
        </div>

        <div className="flex items-center gap-1">
          {canEdit && needsCheck && (
            <>
              <Button variant="secondary" size="sm" disabled={!!busy} onClick={() => act("confirm")}>
                <Check className="size-3.5" /> {busy === "confirm" ? "Saving…" : "Confirm"}
              </Button>
              <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => act("reject")}>
                {busy === "reject" ? "Saving…" : "Wrong"}
              </Button>
            </>
          )}
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls={panelId}
            title={`Why do we believe this? ${percentSure(confidence)}`}
            className="ml-1 inline-flex h-8 items-center gap-2 rounded-md px-2 text-xs transition-colors hover:bg-surface-2">
            {confidence < 0.9 && <span className={clsx("tabular-nums", low ? "font-medium text-warn" : "text-muted")}>{percentSure(confidence)}</span>}
            {provenance.length > 0 ? (
              <span className="flex gap-0.5" aria-label={`${provenance.length} ${provenance.length === 1 ? "source" : "sources"}`}>
                {provenance.slice(0, 4).map((p, i) => (
                  <span key={p.id} className={clsx("min-w-[18px] rounded-[4px] px-1 py-px text-center font-medium tabular-nums",
                    p.confidence < 0.6 ? "bg-warn-tint text-warn" : "bg-accent-tint text-accent")}>{i + 1}</span>
                ))}
                {provenance.length > 4 && <span className="px-0.5 text-accent">+{provenance.length - 4}</span>}
              </span>
            ) : (
              <span className="text-muted">No source</span>
            )}
            <ChevronDown aria-hidden className={clsx("size-3.5 text-muted transition-transform duration-200", open && "rotate-180")} />
          </button>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div id={panelId} key="why" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }} className="overflow-hidden">
            <div className="mt-3 rounded-md bg-surface-2/55 p-3.5">
              <ProvenancePanel items={provenance} agents={agents} title="Why do we believe this?" headingLevel={4}
                emptyText="Nothing recorded behind this fact yet." />
              {canEdit && status === "confirmed" && (
                <div className="mt-3 flex justify-end">
                  <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => act("reject")}>
                    <X className="size-3.5" /> {busy === "reject" ? "Saving…" : "This is wrong"}
                  </Button>
                </div>
              )}
              {canEdit && rejected && (
                <div className="mt-3 flex justify-end">
                  <Button variant="secondary" size="sm" disabled={!!busy} onClick={() => act("confirm")}>
                    {busy === "confirm" ? "Saving…" : "It's right after all"}
                  </Button>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <p aria-live="polite" className="mt-1 text-xs text-danger empty:hidden">{error}</p>
    </li>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={clsx("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
      status === "confirmed" && "bg-accent-tint text-accent",
      status === "unconfirmed" && "bg-warn-tint text-warn",
      status === "inferred" && "bg-inferred-tint text-inferred",
      (status === "rejected" || status === "superseded") && "bg-danger-tint text-danger")}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}
