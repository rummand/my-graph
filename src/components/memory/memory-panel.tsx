"use client";
import { useEffect, useState } from "react";
import { AnimatePresence } from "motion/react";
import { Plus } from "lucide-react";
import { Button, Panel } from "@/components/ui";
import type { MemoryView } from "@/lib/memory/types";
import { useT } from "@/lib/i18n/client";
import { variantOf } from "./variant";
import { MemoryComposer } from "./memory-composer";
import { MemoryItem } from "./memory-item";
import { UndoToast } from "./undo-toast";
import { useMemories } from "./use-memories";

/**
 * "What the assistant remembers about Emma": the memories about one person or node, with add, edit, pause and forget.
 * For person and node pages. Renders nothing for people who can't use Memory (children, guests).
 */
export function MemoryPanel({ aboutNodeId, aboutName, title, graphKind }: {
  aboutNodeId: string; aboutName?: string; title?: string;
  /** The current graph's kind. When a page doesn't pass it, the panel asks /api/graphs. */
  graphKind?: string | null;
}) {
  const t = useT();
  const [kind, setKind] = useState<string | null>(graphKind ?? null);
  const [state, setState] = useState<"loading" | "ready" | "hidden" | "error">("loading");
  const [loaded, setLoaded] = useState<MemoryView[]>([]);
  const [canAdd, setCanAdd] = useState(true);
  const [composing, setComposing] = useState(false);
  const { items, update, remove, undo, prepend, toast, setToast, canUndo } = useMemories(loaded);

  useEffect(() => {
    let live = true;
    setState("loading");
    fetch(`/api/memory?about=${encodeURIComponent(aboutNodeId)}&status=all`)
      .then(async (res) => {
        if (!live) return;
        if (res.status === 403 || res.status === 401) { setState("hidden"); return; }
        if (!res.ok) { setState("error"); return; }
        const body = (await res.json()) as { memories: MemoryView[]; canAdd?: boolean };
        setLoaded(body.memories);
        setCanAdd(body.canAdd !== false);
        setState("ready");
      })
      .catch(() => live && setState("error"));
    return () => { live = false; };
  }, [aboutNodeId]);

  useEffect(() => {
    if (graphKind !== undefined) { setKind(graphKind); return; }
    let live = true;
    fetch("/api/graphs").then((r) => (r.ok ? r.json() : null)).then((b: { graphs?: { id: string; kind: string }[]; currentGraphId?: string } | null) => {
      const g = b?.graphs?.find((x) => x.id === b.currentGraphId);
      if (live && g) setKind(g.kind);
    }).catch(() => {});
    return () => { live = false; };
  }, [graphKind]);

  if (state === "hidden") return null;
  const who = aboutName ?? t("memory.panel.them");
  const vr = variantOf(kind);
  const visible = items.filter((m) => m.status !== "pending" || m.canEdit);

  return (
    <section aria-labelledby={`memory-${aboutNodeId}`}>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 id={`memory-${aboutNodeId}`} className="text-lg font-semibold tracking-[-0.01em]">{title ?? t("memory.panel.title")}</h2>
        {canAdd && state === "ready" && !composing && (
          <Button size="sm" variant="ghost" onClick={() => setComposing(true)}><Plus className="size-4" aria-hidden />{t("memory.panel.add")}</Button>
        )}
      </div>
      {composing && (
        <Panel className="mb-3">
          <MemoryComposer autoFocus people={[]} fixedAboutId={aboutNodeId} graphKind={kind} onCancel={() => setComposing(false)}
            onAdded={(m) => { prepend(m); setComposing(false); }} />
        </Panel>
      )}
      {state === "loading" && <p className="text-sm text-muted">{t("memory.panel.loading")}</p>}
      {state === "error" && <p className="text-sm text-danger">{t("memory.panel.loadError")}</p>}
      {state === "ready" && (visible.length ? (
        <Panel className="px-4 py-0">
          <ul className="divide-y divide-line">
            <AnimatePresence initial={false}>
              {visible.map((m) => (
                <MemoryItem key={m.id} m={m} compact hideAbout={aboutNodeId} graphKind={kind}
                  onUpdate={(id, patch) => update(id, patch)} onRemove={(x) => remove(x)} />
              ))}
            </AnimatePresence>
          </ul>
        </Panel>
      ) : !composing && (
        <p className="text-sm text-muted">{t(`memory.panel.empty.${vr}`, { name: who })}</p>
      ))}
      {state === "ready" && visible.some((m) => m.status === "pending") && (
        <p className="mt-2 text-sm text-muted">{t("memory.panel.pendingBefore")} <a href="/memory" className="text-accent hover:underline">{t("memory.panel.pendingLink")}</a>.</p>
      )}
      <UndoToast toast={toast} onUndo={undo} onClose={() => setToast(null)} canUndo={canUndo} />
    </section>
  );
}
