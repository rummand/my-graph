"use client";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type { Mentionable } from "@/lib/mentions";
import { mentionQueryAt } from "@/lib/mentions/markup";

export type PickedMention = { label: string; nodeId: string; type?: string };
export type TypeaheadItem = { kind: "node"; m: Mentionable } | { kind: "create"; label: string };

/**
 * The @ typeahead for a plain textarea: watches the "@query" at the caret, searches the current graph, and on pick
 * replaces the query with "@Label " (or, for "Create new …", with the plain name, handing it to `onCreate`).
 */
export function useMentionTypeahead({ value, onChange, inputRef, onPick, onCreate }: {
  value: string;
  onChange: (v: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onPick: (m: PickedMention) => void;
  onCreate?: (label: string) => void;
}) {
  const [q, setQ] = useState<{ start: number; query: string } | null>(null);
  const [items, setItems] = useState<TypeaheadItem[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  // Hosts pass inline callbacks; keep the latest in refs so effects don't rerun on every render.
  const onCreateRef = useRef(onCreate);
  const onPickRef = useRef(onPick);
  const onChangeRef = useRef(onChange);
  useEffect(() => { onCreateRef.current = onCreate; onPickRef.current = onPick; onChangeRef.current = onChange; });
  const canCreate = !!onCreate;

  const refresh = useCallback(() => {
    const el = inputRef.current;
    if (!el || document.activeElement !== el) { setQ((cur) => (cur ? null : cur)); return; }
    const next = mentionQueryAt(el.value, el.selectionStart ?? el.value.length);
    setQ((cur) => (cur?.start === next?.start && cur?.query === next?.query ? cur : next));
  }, [inputRef]);

  useEffect(() => { refresh(); }, [value, refresh]);

  useEffect(() => {
    if (!q) { setItems((x) => (x.length ? [] : x)); return; }
    const n = ++seq.current;
    setLoading(true);
    const t = window.setTimeout(async () => {
      const res = await fetch(`/api/mentions?q=${encodeURIComponent(q.query)}&limit=7`).catch(() => null);
      const body = res?.ok ? await res.json().catch(() => null) : null;
      if (n !== seq.current) return;
      const found: TypeaheadItem[] = ((body?.items ?? []) as Mentionable[]).map((m) => ({ kind: "node", m }));
      const exact = found.some((f) => f.kind === "node" && f.m.label.toLowerCase() === q.query.trim().toLowerCase());
      if (canCreate && q.query.trim().length >= 2 && !exact) found.push({ kind: "create", label: q.query.trim() });
      setItems(found);
      setActive(0);
      setLoading(false);
    }, q.query ? 120 : 0);
    return () => window.clearTimeout(t);
  }, [q, canCreate]);

  const pick = useCallback((item: TypeaheadItem) => {
    const el = inputRef.current;
    if (!el || !q) return;
    const caret = el.selectionStart ?? value.length;
    const insert = item.kind === "node" ? `@${item.m.label} ` : `${item.label} `;
    const next = value.slice(0, q.start) + insert + value.slice(caret);
    onChangeRef.current(next);
    if (item.kind === "node") onPickRef.current({ label: item.m.label, nodeId: item.m.nodeId, type: item.m.type });
    else onCreateRef.current?.(item.label);
    setQ(null);
    const pos = q.start + insert.length;
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(pos, pos); });
  }, [inputRef, q, value]);

  /** Returns true when the key was for the menu. */
  const onKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!q || !items.length) return false;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % items.length); return true; }
    if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a - 1 + items.length) % items.length); return true; }
    if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") { e.preventDefault(); pick(items[active]); return true; }
    if (e.key === "Escape") { e.preventDefault(); setQ(null); return true; }
    return false;
  }, [q, items, active, pick]);

  return { open: !!q && (items.length > 0 || loading), query: q?.query ?? "", items, active, setActive, pick, onKeyDown, refresh, close: () => setQ(null), loading };
}
