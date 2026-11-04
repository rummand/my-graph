"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MemoryView } from "@/lib/memory/types";
import { useT } from "@/lib/i18n/client";
import { memoryApi } from "./api";

const UNDO_MS = 6000;

/**
 * Local list of memories with the actions the page and panel share. Delete is deferred: the memory leaves the list at
 * once, an undo toast shows, and the real DELETE goes out when the toast times out (or when the page is left).
 */
export function useMemories(initial: MemoryView[]) {
  const tr = useT();
  const [items, setItems] = useState(initial);
  const [toast, setToast] = useState<{ id: string; text: string; error?: boolean } | null>(null);
  const timers = useRef(new Map<string, { t: ReturnType<typeof setTimeout>; item: MemoryView; index: number }>());

  useEffect(() => setItems(initial), [initial]);

  const flushAll = useCallback(() => {
    for (const [id, p] of timers.current) {
      clearTimeout(p.t);
      void memoryApi.remove(id, true).catch(() => {});
    }
    timers.current.clear();
  }, []);

  useEffect(() => {
    const onHide = () => flushAll();
    window.addEventListener("pagehide", onHide);
    return () => { window.removeEventListener("pagehide", onHide); flushAll(); };
  }, [flushAll]);

  const replace = useCallback((m: MemoryView) => setItems((xs) => xs.map((x) => (x.id === m.id ? m : x))), []);
  const prepend = useCallback((m: MemoryView) => setItems((xs) => [m, ...xs.filter((x) => x.id !== m.id)]), []);

  const update = useCallback(async (id: string, patch: Parameters<typeof memoryApi.update>[1]) => {
    const m = await memoryApi.update(id, patch);
    replace(m);
    return m;
  }, [replace]);

  const itemsRef = useRef(items);
  useEffect(() => { itemsRef.current = items; }, [items]);

  const remove = useCallback((m: MemoryView, label?: string) => {
    const index = itemsRef.current.findIndex((x) => x.id === m.id);
    const prev = timers.current.get(m.id);
    if (prev) clearTimeout(prev.t);
    const t = setTimeout(async () => {
      timers.current.delete(m.id);
      try {
        await memoryApi.remove(m.id);
      } catch (e) {
        setItems((cur) => [m, ...cur.filter((x) => x.id !== m.id)]);
        setToast({ id: m.id, text: e instanceof Error ? e.message : tr("memory.removeFailed"), error: true });
      }
    }, UNDO_MS);
    timers.current.set(m.id, { t, item: m, index });
    setItems((xs) => xs.filter((x) => x.id !== m.id));
    setToast({ id: m.id, text: label ?? tr("memory.forgotten") });
  }, [tr]);

  const undo = useCallback((id: string) => {
    const p = timers.current.get(id);
    if (!p) return;
    clearTimeout(p.t);
    timers.current.delete(id);
    setItems((xs) => {
      const next = [...xs];
      next.splice(Math.min(Math.max(p.index, 0), next.length), 0, p.item);
      return next;
    });
    setToast(null);
  }, []);

  return { items, setItems, update, remove, undo, prepend, toast, setToast, canUndo: (id: string) => timers.current.has(id) };
}
