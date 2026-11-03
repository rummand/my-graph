"use client";
/**
 * Details for one timeline item: a drawer that slides in from the right on desktop, a sheet that rises on phones.
 * Sources come from GBrain's node API and show as citation chips with the passage they came from.
 */
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";
import { Badge, CitationChip, IconButton, NodeChip, PersonChip, buttonClass } from "@/components/ui";
import { formatWhen } from "@/lib/timeline/pure";
import type { TimelineItem } from "@/lib/timeline/types";
import { parseNodeDetail, type DrawerDetail } from "@/lib/timeline/node-detail";
import { ItemGlyph, KIND_LABEL, STATUS_LABEL } from "./marks";

type Load = { state: "idle" } | { state: "loading" } | { state: "error"; message: string } | { state: "ready"; detail: DrawerDetail };

const EASE = [0.22, 1, 0.36, 1] as const;

export function EventDrawer({ item, peopleById, onClose, isPhone }: {
  item: TimelineItem | null;
  peopleById: Map<string, string>;
  onClose: () => void;
  isPhone: boolean;
}) {
  const returnFocus = useRef<Element | null>(null);

  // Remember where focus was; give it back when the drawer closes.
  useEffect(() => {
    if (item) returnFocus.current ??= document.activeElement;
    else if (returnFocus.current) {
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

  return (
    <AnimatePresence>
      {item && isPhone && (
        <motion.div key="scrim" className="fixed inset-0 z-40 bg-black/30" aria-hidden="true" onClick={onClose}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} />
      )}
      {item && (
        <motion.aside
          key="drawer"
          role="dialog"
          aria-modal={isPhone}
          aria-labelledby="timeline-drawer-title"
          className={isPhone
            ? "fixed inset-x-0 bottom-0 z-50 flex max-h-[85vh] flex-col rounded-t-2xl bg-surface shadow-float"
            : "fixed inset-y-3 right-3 z-50 flex w-[420px] max-w-[calc(100vw-24px)] flex-col rounded-xl bg-surface shadow-float"}
          initial={isPhone ? { y: "100%" } : { x: "calc(100% + 12px)" }}
          animate={isPhone ? { y: 0 } : { x: 0 }}
          exit={isPhone ? { y: "100%" } : { x: "calc(100% + 12px)" }}
          transition={{ duration: 0.24, ease: EASE }}
        >
          <DrawerBody item={item} peopleById={peopleById} onClose={onClose} isPhone={isPhone} />
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

function DrawerBody({ item, peopleById, onClose, isPhone }: { item: TimelineItem; peopleById: Map<string, string>; onClose: () => void; isPhone: boolean }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [load, setLoad] = useState<Load>({ state: "idle" });
  const [retry, setRetry] = useState(0);

  useEffect(() => { headingRef.current?.focus({ preventScroll: true }); }, [item.id]);

  const nodeId = item.nodeId;
  useEffect(() => {
    if (!nodeId) { setLoad({ state: "idle" }); return; }
    const ac = new AbortController();
    setLoad({ state: "loading" });
    fetch(`/api/nodes/${encodeURIComponent(nodeId)}`, { signal: ac.signal, headers: { accept: "application/json" } })
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        if (!r.ok) {
          const msg = body && typeof body.error === "string" ? body.error
            : r.status === 404 ? "This no longer exists, or it isn't shared with you." : "We couldn't load the sources.";
          setLoad({ state: "error", message: msg });
          return;
        }
        setLoad({ state: "ready", detail: parseNodeDetail(body) });
      })
      .catch((err) => { if (!ac.signal.aborted) setLoad({ state: "error", message: err instanceof Error && err.message.includes("fetch") ? "You seem to be offline." : "We couldn't load the sources." }); });
    return () => ac.abort();
  }, [nodeId, retry]);

  const when = formatWhen(item.start, item.end, item.precision);
  const people = item.personIds.map((id) => ({ id, label: peopleById.get(id) })).filter((p): p is { id: string; label: string } => !!p.label);
  const detail = load.state === "ready" ? load.detail : null;
  const summary = item.summary ?? detail?.summary ?? null;

  return (
    <>
      {isPhone && <div className="mx-auto mt-2.5 h-1 w-9 shrink-0 rounded-full bg-line" aria-hidden="true" />}
      <header className="flex items-start gap-3 px-6 pb-5 pt-5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
            <ItemGlyph item={item} personId={item.personIds[0]} size={15} />
            <span>{KIND_LABEL[item.kind]}</span>
            {item.kind === "event" && item.status !== "confirmed" && (
              <Badge tone={item.status === "inferred" ? "inferred" : "warn"}>{STATUS_LABEL[item.status]}</Badge>
            )}
            {item.overdue && <Badge tone="danger">Overdue</Badge>}
            {item.sensitive && <Badge>Sensitive</Badge>}
          </div>
          <h2 id="timeline-drawer-title" ref={headingRef} tabIndex={-1} className="mt-2 text-xl font-semibold leading-snug tracking-[-0.01em] [text-wrap:balance] focus:outline-none">
            {item.title}
          </h2>
          <p className="mt-1 text-muted">
            {item.kind === "reminder" ? `Due ${when}` : item.kind === "source" ? `Added ${when}` : <time dateTime={item.start}>{when}</time>}
          </p>
        </div>
        <IconButton label="Close details" onClick={onClose} className="-mr-2 -mt-1"><X size={18} /></IconButton>
      </header>

      <div className="flex-1 space-y-6 overflow-y-auto px-6 pb-6">
        {people.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {people.map((p) => <PersonChip key={p.id} id={p.id} name={p.label} href={`/people/${p.id}`} />)}
          </div>
        )}

        {summary && <p className="leading-relaxed">{summary}</p>}

        {item.status === "inferred" && item.kind === "event" && (
          <p className="rounded-lg bg-inferred-tint px-4 py-3 text-sm text-inferred">
            The assistant worked this out from other facts. It stays marked as inferred until someone confirms it on the graph page.
          </p>
        )}

        {nodeId && <SourcesSection load={load} onRetry={() => setRetry((n) => n + 1)} />}

        {!nodeId && item.sourceId && (
          <section>
            <h3 className="mb-2 text-sm font-medium">Where this comes from</h3>
            <CitationChip n={1} title={item.kind === "source" ? item.title : "The document this came from"} href={`/library/${item.sourceId}`} />
          </section>
        )}

        {detail && detail.related.length > 0 && (
          <section>
            <h3 className="mb-2 text-sm font-medium">Connected to</h3>
            <div className="flex flex-wrap gap-1.5">
              {detail.related.map((n) => <NodeChip key={n.id} type={n.type} label={n.label} href={`/node/${n.id}`} />)}
            </div>
          </section>
        )}
      </div>

      {(nodeId || item.kind === "source" || item.kind === "reminder") && (
        <footer className="flex flex-wrap gap-2 bg-surface-2/50 px-6 py-4 sm:rounded-b-xl">
          {nodeId && <Link href={`/node/${nodeId}`} className={buttonClass("primary")}>Open in graph</Link>}
          {item.kind === "source" && item.sourceId && <Link href={`/library/${item.sourceId}`} className={buttonClass(nodeId ? "secondary" : "primary")}>Open in library</Link>}
          {item.kind === "reminder" && <Link href="/" className={buttonClass("secondary")}>See on Today</Link>}
        </footer>
      )}
    </>
  );
}

function SourcesSection({ load, onRetry }: { load: Load; onRetry: () => void }) {
  return (
    <section aria-busy={load.state === "loading"}>
      <h3 className="mb-2.5 text-sm font-medium">Where this comes from</h3>
      {load.state === "loading" && (
        <div className="space-y-2" aria-label="Loading sources">
          <div className="h-5 w-2/3 animate-pulse rounded bg-surface-2" />
          <div className="h-14 animate-pulse rounded-lg bg-surface-2" />
        </div>
      )}
      {load.state === "error" && (
        <p className="text-sm text-muted">
          {load.message}{" "}
          <button type="button" onClick={onRetry} className="font-medium text-accent hover:underline">Try again</button>
        </p>
      )}
      {load.state === "ready" && load.detail.sources.length === 0 && (
        <p className="text-sm text-muted">No source is recorded for this. It was probably added by hand.</p>
      )}
      {load.state === "ready" && load.detail.sources.length > 0 && (
        <ol className="space-y-3">
          {load.detail.sources.map((s, i) => (
            <li key={s.key}>
              <CitationChip n={i + 1} title={s.title} detail={s.detail} confidence={s.confidence ?? undefined}
                href={s.sourceId ? `/library/${s.sourceId}` : undefined} />
              {s.quote && <blockquote className="mt-2 rounded-lg bg-surface-2/70 px-3.5 py-2.5 text-sm leading-relaxed">“{s.quote}”</blockquote>}
              {s.how && <p className="mt-1.5 text-xs text-muted">{s.how}</p>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
