"use client";
import { useEffect, useState } from "react";
import { AnimatePresence } from "motion/react";
import { Plus } from "lucide-react";
import { Button, Panel } from "@/components/ui";
import type { MemoryView } from "@/lib/memory/types";
import { MemoryComposer } from "./memory-composer";
import { MemoryItem } from "./memory-item";
import { UndoToast } from "./undo-toast";
import { useMemories } from "./use-memories";

/**
 * "What the assistant remembers about Emma": the memories about one person or node, with add, edit, pause and forget.
 * For person and node pages. Renders nothing for people who can't use Memory (children, guests).
 */
export function MemoryPanel({ aboutNodeId, aboutName, title }: { aboutNodeId: string; aboutName?: string; title?: string }) {
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

  if (state === "hidden") return null;
  const who = aboutName ?? "them";
  const visible = items.filter((m) => m.status !== "pending" || m.canEdit);

  return (
    <section aria-labelledby={`memory-${aboutNodeId}`}>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 id={`memory-${aboutNodeId}`} className="text-lg font-semibold tracking-[-0.01em]">{title ?? "What the assistant remembers"}</h2>
        {canAdd && state === "ready" && !composing && (
          <Button size="sm" variant="ghost" onClick={() => setComposing(true)}><Plus className="size-4" aria-hidden />Add</Button>
        )}
      </div>
      {composing && (
        <Panel className="mb-3">
          <MemoryComposer autoFocus people={[]} fixedAboutId={aboutNodeId} onCancel={() => setComposing(false)}
            onAdded={(m) => { prepend(m); setComposing(false); }} />
        </Panel>
      )}
      {state === "loading" && <p className="text-sm text-muted">Loading…</p>}
      {state === "error" && <p className="text-sm text-danger">Couldn&rsquo;t load what&rsquo;s remembered. Reload the page to try again.</p>}
      {state === "ready" && (visible.length ? (
        <Panel className="px-4 py-0">
          <ul className="divide-y divide-line">
            <AnimatePresence initial={false}>
              {visible.map((m) => (
                <MemoryItem key={m.id} m={m} compact hideAbout={aboutNodeId}
                  onUpdate={(id, patch) => update(id, patch)} onRemove={(x) => remove(x)} />
              ))}
            </AnimatePresence>
          </ul>
        </Panel>
      ) : !composing && (
        <p className="text-sm text-muted">
          Nothing remembered about {who} yet. Rules and preferences about {who}, like bedtimes or who can pick them up, show up here.
        </p>
      ))}
      {state === "ready" && visible.some((m) => m.status === "pending") && (
        <p className="mt-2 text-sm text-muted">Some of these wait for you to confirm them on the <a href="/memory" className="text-accent hover:underline">Memory page</a>.</p>
      )}
      <UndoToast toast={toast} onUndo={undo} onClose={() => setToast(null)} canUndo={canUndo} />
    </section>
  );
}
