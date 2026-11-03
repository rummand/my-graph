"use client";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import Link from "next/link";
import { clsx } from "clsx";
import { AnimatePresence, motion } from "motion/react";
import { Check, Pencil, SquarePen, Trash2, X } from "lucide-react";
import type { ConversationSummary } from "@/lib/assistant/store";
import { groupByRecency } from "./recency";

const EASE = [0.22, 1, 0.36, 1] as const;

/** Conversations, newest first, grouped by when they were last used. Rename and delete happen in the row. */
export function ConversationList({ list, activeId, onNew, onRename, onDelete, onNavigate, busy }: {
  list: ConversationSummary[];
  activeId: string | null;
  onNew: (e: MouseEvent) => void;
  onRename: (id: string, title: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
  onNavigate?: () => void;
  busy: boolean;
}) {
  const groups = useMemo(() => groupByRecency(list), [list]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Link href="/chat" onClick={onNew}
        className="mb-4 inline-flex h-9 items-center gap-2 rounded-md px-2.5 text-sm font-medium text-fg transition-colors hover:bg-surface-2">
        <SquarePen aria-hidden className="size-4 text-muted" /> New conversation
      </Link>
      <nav aria-label="Conversations" className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 pb-4">
        {list.length === 0 ? (
          <p className="px-2.5 text-sm leading-relaxed text-muted">Questions you ask are kept here, so you can come back to an answer and its sources.</p>
        ) : (
          groups.map((g) => (
            <section key={g.key} className="mb-5" aria-label={g.label}>
              <h2 className="mb-1 px-2.5 text-xs font-medium text-muted">{g.label}</h2>
              <ul>
                <AnimatePresence initial={false}>
                  {g.items.map((c) => (
                    <motion.li key={c.id} layout="position" exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.18, ease: EASE }}>
                      <Row c={c} active={c.id === activeId} busy={busy && c.id === activeId}
                        onRename={onRename} onDelete={onDelete} onNavigate={onNavigate} />
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ul>
            </section>
          ))
        )}
      </nav>
    </div>
  );
}

function Row({ c, active, busy, onRename, onDelete, onNavigate }: {
  c: ConversationSummary; active: boolean; busy: boolean;
  onRename: (id: string, title: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
  onNavigate?: () => void;
}) {
  const [mode, setMode] = useState<"view" | "rename" | "delete">("view");
  const [draft, setDraft] = useState(c.title);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (mode === "rename") inputRef.current?.select(); }, [mode]);

  async function save() {
    const t = draft.trim();
    if (!t || t === c.title) { setMode("view"); setDraft(c.title); return; }
    setSaving(true);
    const ok = await onRename(c.id, t);
    setSaving(false);
    if (ok) setMode("view");
  }

  async function remove() {
    setSaving(true);
    const ok = await onDelete(c.id);
    if (!ok) { setSaving(false); setMode("view"); }
  }

  if (mode === "rename") {
    return (
      <form className="flex items-center gap-1 rounded-md bg-surface py-1 pl-1 pr-1" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label htmlFor={`rename-${c.id}`} className="sr-only">New name for this conversation</label>
        <input id={`rename-${c.id}`} ref={inputRef} value={draft} maxLength={120} disabled={saving}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") { setMode("view"); setDraft(c.title); } }}
          className="h-7 min-w-0 flex-1 rounded-[5px] bg-transparent px-1.5 text-sm outline-none ring-1 ring-inset ring-accent" />
        <RowButton label="Save name" type="submit" disabled={saving}><Check className="size-4" /></RowButton>
        <RowButton label="Cancel" onClick={() => { setMode("view"); setDraft(c.title); }}><X className="size-4" /></RowButton>
      </form>
    );
  }

  if (mode === "delete") {
    return (
      <div className="rounded-md bg-danger-tint px-2.5 py-2 text-sm" role="group" aria-label={`Delete ${c.title}`}>
        <p className="font-medium text-danger">Delete this conversation?</p>
        <p className="mt-0.5 text-xs text-fg/70">Reminders, facts and pages you approved from it stay.</p>
        <div className="mt-2 flex gap-1.5">
          <button type="button" onClick={remove} disabled={saving} autoFocus
            className="h-7 rounded-[5px] bg-danger px-2.5 text-xs font-medium text-white transition-transform active:scale-[0.97] disabled:opacity-60">
            {saving ? "Deleting…" : "Delete"}
          </button>
          <button type="button" onClick={() => setMode("view")} disabled={saving}
            className="h-7 rounded-[5px] px-2.5 text-xs text-fg/80 hover:bg-surface/60">Keep it</button>
        </div>
      </div>
    );
  }

  return (
    <div className={clsx("group/row relative rounded-md transition-colors",
      active ? "bg-surface text-fg" : "text-fg/80 hover:bg-surface-2 hover:text-fg")}>
      <Link href={`/chat/${c.id}`} aria-current={active ? "page" : undefined} onClick={onNavigate} title={c.title}
        className={clsx("block truncate py-2 pl-2.5 pr-2.5 text-sm [@media(hover:hover)]:group-hover/row:pr-16 [@media(hover:hover)]:group-focus-within/row:pr-16 max-[1023px]:pr-16", active && "font-medium")}>
        {c.title}
      </Link>
      <div className={clsx("absolute inset-y-0 right-1 flex items-center transition-opacity",
        "[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/row:opacity-100 [@media(hover:hover)]:group-focus-within/row:opacity-100")}>
        <RowButton label={`Rename ${c.title}`} onClick={() => setMode("rename")}><Pencil className="size-3.5" /></RowButton>
        <RowButton label={`Delete ${c.title}`} onClick={() => setMode("delete")} disabled={busy}><Trash2 className="size-3.5" /></RowButton>
      </div>
    </div>
  );
}

function RowButton({ label, children, type = "button", onClick, disabled }: {
  label: string; children: React.ReactNode; type?: "button" | "submit"; onClick?: () => void; disabled?: boolean;
}) {
  return (
    <button type={type} aria-label={label} title={label} onClick={onClick} disabled={disabled}
      className="inline-flex size-7 items-center justify-center rounded-[5px] text-muted transition-colors hover:bg-bg hover:text-fg disabled:opacity-40 [&_svg]:pointer-events-none"
    >{children}</button>
  );
}
