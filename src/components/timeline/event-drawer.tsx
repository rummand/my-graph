"use client";
/** Details for one timeline item: side drawer on desktop, bottom sheet on phones. Sources come from GBrain's node API. */
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { clsx } from "clsx";
import { CitationChip, NodeChip } from "@/components/ui";
import { formatWhen } from "@/lib/timeline/pure";
import type { TimelineItem } from "@/lib/timeline/types";
import { ItemGlyph, KIND_LABEL, STATUS_LABEL } from "./marks";
import { parseNodeDetail, type DrawerDetail } from "@/lib/timeline/node-detail";

type Load = { state: "idle" } | { state: "loading" } | { state: "error"; message: string } | { state: "ready"; detail: DrawerDetail };

export function EventDrawer({ item, peopleById, onClose }: {
  item: TimelineItem | null;
  peopleById: Map<string, string>;
  onClose: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const returnFocus = useRef<Element | null>(null);
  const [load, setLoad] = useState<Load>({ state: "idle" });
  const [retry, setRetry] = useState(0);

  // Focus the heading when opened; give focus back when closed.
  useEffect(() => {
    if (item) {
      returnFocus.current ??= document.activeElement;
      headingRef.current?.focus({ preventScroll: true });
    } else if (returnFocus.current) {
      (returnFocus.current as HTMLElement).focus?.({ preventScroll: true });
      returnFocus.current = null;
    }
  }, [item]);

  useEffect(() => {
    if (!item) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [item, onClose]);

  const nodeId = item?.nodeId ?? null;
  useEffect(() => {
    if (!nodeId) { setLoad({ state: "idle" }); return; }
    const ac = new AbortController();
    setLoad({ state: "loading" });
    fetch(`/api/nodes/${encodeURIComponent(nodeId)}`, { signal: ac.signal, headers: { accept: "application/json" } })
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        if (!r.ok) {
          const msg = body && typeof body.error === "string" ? body.error
            : r.status === 404 ? "This item no longer exists or isn't shared with you." : "We couldn't load the sources.";
          setLoad({ state: "error", message: msg });
          return;
        }
        setLoad({ state: "ready", detail: parseNodeDetail(body) });
      })
      .catch((err) => { if (!ac.signal.aborted) setLoad({ state: "error", message: err instanceof Error && err.message.includes("fetch") ? "You seem to be offline." : "We couldn't load the sources." }); });
    return () => ac.abort();
  }, [nodeId, retry]);

  if (!item) return null;

  const when = formatWhen(item.start, item.end, item.precision);
  const people = item.personIds.map((id) => ({ id, label: peopleById.get(id) })).filter((p): p is { id: string; label: string } => !!p.label);
  const detail = load.state === "ready" ? load.detail : null;
  const summary = item.summary ?? detail?.summary ?? null;

  return (
    <>
      {/* Scrim only on phones, where the sheet covers the list. */}
      <div className="fixed inset-0 z-40 bg-black/30 sm:hidden" aria-hidden="true" onClick={onClose} />
      <aside
        role="dialog"
        aria-modal="false"
        aria-labelledby="timeline-drawer-title"
        className={clsx(
          "fixed z-50 flex flex-col border-line bg-surface shadow-2xl",
          "inset-x-0 bottom-0 max-h-[85vh] rounded-t-2xl border-t",
          "sm:inset-x-auto sm:inset-y-0 sm:right-0 sm:max-h-none sm:w-[420px] sm:max-w-[92vw] sm:rounded-none sm:border-l sm:border-t-0",
        )}
      >
        <div className="mx-auto mt-2 h-1.5 w-10 rounded-full bg-line sm:hidden" aria-hidden="true" />
        <header className="flex items-start gap-3 border-b border-line px-5 pb-4 pt-3 sm:pt-5">
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <ItemGlyph item={item} size={14} />
              <span>{KIND_LABEL[item.kind]}</span>
              {item.kind === "event" && <span aria-hidden="true">·</span>}
              {item.kind === "event" && (
                <span className={clsx(item.status === "inferred" && "text-inferred", item.status === "unconfirmed" && "text-warn")}>{STATUS_LABEL[item.status]}</span>
              )}
              {item.overdue && <span className="rounded bg-surface-2 px-1.5 py-0.5 font-medium text-danger">Overdue</span>}
              {item.sensitive && <span className="rounded bg-surface-2 px-1.5 py-0.5">Sensitive</span>}
            </p>
            <h2 id="timeline-drawer-title" ref={headingRef} tabIndex={-1} style={{ outline: "none" }} className="mt-1.5 text-lg font-semibold leading-snug">
              {item.title}
            </h2>
            <p className="mt-1 text-sm text-muted">
              {item.kind === "reminder" ? `Due ${when}` : item.kind === "source" ? `Added ${when}` : <time dateTime={item.start}>{when}</time>}
            </p>
          </div>
          <button type="button" onClick={onClose} className="-mr-2 rounded-md p-2 text-muted hover:bg-surface-2 hover:text-fg" aria-label="Close details">
            <X size={18} />
          </button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4 text-sm">
          {people.length > 0 && (
            <section>
              <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted">People</h3>
              <div className="flex flex-wrap gap-1.5">
                {people.map((p) => <NodeChip key={p.id} type="person" label={p.label} href={`/people/${p.id}`} />)}
              </div>
            </section>
          )}

          {summary && <p className="leading-relaxed">{summary}</p>}

          {item.status === "inferred" && item.kind === "event" && (
            <p className="rounded-md border border-dashed border-inferred px-3 py-2 text-xs text-muted">
              The assistant worked this out from other facts. It stays marked as inferred until someone confirms it on the graph page.
            </p>
          )}

          {nodeId && <SourcesSection load={load} onRetry={() => setRetry((n) => n + 1)} />}

          {!nodeId && item.sourceId && (
            <section>
              <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted">Source</h3>
              <CitationChip n={1} title={item.kind === "source" ? item.title : "Open the document this came from"} href={`/library/${item.sourceId}`} />
            </section>
          )}

          {detail && detail.related.length > 0 && (
            <section>
              <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted">Connected to</h3>
              <div className="flex flex-wrap gap-1.5">
                {detail.related.map((n) => <NodeChip key={n.id} type={n.type} label={n.label} href={`/node/${n.id}`} />)}
              </div>
            </section>
          )}
        </div>

        <footer className="flex flex-wrap gap-2 border-t border-line px-5 py-3">
          {nodeId && (
            <Link href={`/node/${nodeId}`} className="inline-flex items-center rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-fg hover:opacity-90">
              Open in graph
            </Link>
          )}
          {item.kind === "source" && item.sourceId && (
            <Link href={`/library/${item.sourceId}`} className="inline-flex items-center rounded-md border border-line px-3 py-2 text-sm font-medium hover:bg-surface-2">
              Open in library
            </Link>
          )}
          {item.kind === "reminder" && (
            <Link href="/" className="inline-flex items-center rounded-md border border-line px-3 py-2 text-sm font-medium hover:bg-surface-2">
              See on Today
            </Link>
          )}
        </footer>
      </aside>
    </>
  );
}

function SourcesSection({ load, onRetry }: { load: Load; onRetry: () => void }) {
  return (
    <section aria-busy={load.state === "loading"}>
      <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted">Where this comes from</h3>
      {load.state === "loading" && (
        <div className="space-y-2" aria-label="Loading sources">
          <div className="h-5 w-3/4 animate-pulse rounded bg-surface-2" />
          <div className="h-12 animate-pulse rounded bg-surface-2" />
        </div>
      )}
      {load.state === "error" && (
        <p className="text-muted">
          {load.message}{" "}
          <button type="button" onClick={onRetry} className="font-medium text-accent hover:underline">Try again</button>
        </p>
      )}
      {load.state === "ready" && load.detail.sources.length === 0 && (
        <p className="text-muted">No source is recorded for this yet. It was probably added by hand.</p>
      )}
      {load.state === "ready" && load.detail.sources.length > 0 && (
        <ol className="space-y-3">
          {load.detail.sources.map((s, i) => (
            <li key={s.key} className="space-y-1">
              <CitationChip n={i + 1} title={s.title} detail={s.detail} confidence={s.confidence ?? undefined}
                href={s.sourceId ? `/library/${s.sourceId}` : undefined} />
              {s.quote && <blockquote className="border-l-2 border-line pl-3 text-xs leading-relaxed text-muted">“{s.quote}”</blockquote>}
              {s.how && <p className="text-[11px] text-muted">{s.how}</p>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
