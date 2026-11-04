"use client";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import Link from "next/link";
import { clsx } from "clsx";
import { AnimatePresence, motion } from "motion/react";
import { Check, Pencil, Pin, PinOff, Search, SquarePen, Trash2, X } from "lucide-react";
import type { ConversationSummary } from "@/lib/assistant/store";
import { useLocale, useT } from "@/lib/i18n/client";
import { groupForInbox } from "./recency";

const EASE = [0.22, 1, 0.36, 1] as const;

type RowActions = {
  onRename: (id: string, title: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
  onPin: (id: string, pinned: boolean) => Promise<boolean>;
};

/** Conversations like an inbox: search, pinned first, then by when they were last used. Unread ones are bold. */
export function ConversationList({ list, activeId, onNew, onRename, onDelete, onPin, onNavigate, busy }: {
  list: ConversationSummary[];
  activeId: string | null;
  onNew: (e: MouseEvent) => void;
  onNavigate?: () => void;
  busy: boolean;
} & RowActions) {
  const t = useT();
  const locale = useLocale();
  const groups = useMemo(() => groupForInbox(list, new Date(), { t, locale }), [list, t, locale]);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<ConversationSummary[] | null>(null);
  const [searching, setSearching] = useState(false);

  // Search titles and message text (debounced; own conversations in this graph only, server-side).
  useEffect(() => {
    const needle = q.trim();
    if (!needle) { setResults(null); setSearching(false); return; }
    setSearching(true);
    const ac = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/chat?q=${encodeURIComponent(needle)}`, { signal: ac.signal });
        const body = await res.json().catch(() => ({}));
        setResults(res.ok && Array.isArray(body.conversations) ? body.conversations : []);
      } catch { /* aborted or offline */ } finally {
        if (!ac.signal.aborted) setSearching(false);
      }
    }, 220);
    return () => { ac.abort(); window.clearTimeout(timer); };
  }, [q]);

  // Keep search results in step with renames, pins and deletes made from them.
  const shown: ConversationSummary[] | null = results
    ? results.flatMap((r) => { const cur = list.find((c) => c.id === r.id); return cur ? [{ ...cur, snippet: r.snippet }] : []; })
    : null;
  const actions = { onRename, onDelete, onPin };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Link href="/chat" onClick={onNew}
        className="mb-2 inline-flex h-9 items-center gap-2 rounded-md px-2.5 text-sm font-medium text-fg transition-colors hover:bg-surface-2">
        <SquarePen aria-hidden className="size-4 text-muted" /> {t("chat.list.new")}
      </Link>
      {list.length > 0 && (
        <div className="relative mb-4">
          <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
          <label htmlFor="chat-search" className="sr-only">{t("chat.list.search")}</label>
          <input id="chat-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} maxLength={200}
            onKeyDown={(e) => { if (e.key === "Escape") setQ(""); }}
            placeholder={t("chat.list.search")}
            className="h-8 w-full rounded-md bg-surface-2 pl-8 pr-2 text-sm outline-none placeholder:text-muted/80 focus-visible:bg-surface focus-visible:ring-1 focus-visible:ring-accent" />
        </div>
      )}
      <nav aria-label={t("chat.list.nav")} className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 pb-4">
        {shown ? (
          <section aria-label={t("chat.list.results")}>
            <h2 className="mb-1 px-2.5 text-xs font-medium text-muted">
              {searching && !shown.length ? t("chat.list.searching") : shown.length ? t("chat.list.count", { count: shown.length }) : t("chat.list.noMatch", { q: q.trim() })}
            </h2>
            <ul>
              {shown.map((c) => (
                <li key={c.id}>
                  <Row c={c} active={c.id === activeId} busy={busy && c.id === activeId} {...actions} onNavigate={onNavigate} />
                </li>
              ))}
            </ul>
          </section>
        ) : list.length === 0 ? (
          <p className="px-2.5 text-sm leading-relaxed text-muted">{t("chat.list.empty")}</p>
        ) : (
          groups.map((g) => (
            <section key={g.key} className="mb-5" aria-label={g.label}>
              <h2 className="mb-1 px-2.5 text-xs font-medium text-muted">{g.label}</h2>
              <ul>
                <AnimatePresence initial={false}>
                  {g.items.map((c) => (
                    <motion.li key={c.id} layout="position" exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.18, ease: EASE }}>
                      <Row c={c} active={c.id === activeId} busy={busy && c.id === activeId} {...actions} onNavigate={onNavigate} />
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

function Row({ c, active, busy, onRename, onDelete, onPin, onNavigate }: {
  c: ConversationSummary; active: boolean; busy: boolean; onNavigate?: () => void;
} & RowActions) {
  const t = useT();
  const [mode, setMode] = useState<"view" | "rename" | "delete">("view");
  const [draft, setDraft] = useState(c.title);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (mode === "rename") inputRef.current?.select(); }, [mode]);

  async function save() {
    const next = draft.trim();
    if (!next || next === c.title) { setMode("view"); setDraft(c.title); return; }
    setSaving(true);
    const ok = await onRename(c.id, next);
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
        <label htmlFor={`rename-${c.id}`} className="sr-only">{t("chat.list.newName")}</label>
        <input id={`rename-${c.id}`} ref={inputRef} value={draft} maxLength={120} disabled={saving}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") { setMode("view"); setDraft(c.title); } }}
          className="h-7 min-w-0 flex-1 rounded-[5px] bg-transparent px-1.5 text-sm outline-none ring-1 ring-inset ring-accent" />
        <RowButton label={t("chat.list.saveName")} type="submit" disabled={saving}><Check className="size-4" /></RowButton>
        <RowButton label={t("chat.list.cancel")} onClick={() => { setMode("view"); setDraft(c.title); }}><X className="size-4" /></RowButton>
      </form>
    );
  }

  if (mode === "delete") {
    return (
      <div className="rounded-md bg-danger-tint px-2.5 py-2 text-sm" role="group" aria-label={t("chat.list.deleteLabel", { title: c.title })}>
        <p className="font-medium text-danger">{t("chat.list.deleteQ")}</p>
        <p className="mt-0.5 text-xs text-fg/70">{t("chat.list.deleteKeeps")}</p>
        <div className="mt-2 flex gap-1.5">
          <button type="button" onClick={remove} disabled={saving} autoFocus
            className="h-7 rounded-[5px] bg-danger px-2.5 text-xs font-medium text-white transition-transform active:scale-[0.97] disabled:opacity-60">
            {saving ? t("chat.list.deleting") : t("chat.list.delete")}
          </button>
          <button type="button" onClick={() => setMode("view")} disabled={saving}
            className="h-7 rounded-[5px] px-2.5 text-xs text-fg/80 hover:bg-surface/60">{t("chat.list.keep")}</button>
        </div>
      </div>
    );
  }

  return (
    <div className={clsx("group/row relative rounded-md transition-colors",
      active ? "bg-surface text-fg" : "text-fg/80 hover:bg-surface-2 hover:text-fg")}>
      <Link href={`/chat/${c.id}`} aria-current={active ? "page" : undefined} onClick={onNavigate} title={c.title}
        className={clsx("block py-2 pl-2.5 pr-2.5 text-sm [@media(hover:hover)]:group-hover/row:pr-[92px] [@media(hover:hover)]:group-focus-within/row:pr-[92px] max-[1023px]:pr-[92px]",
          (active || c.unread) && "font-medium", c.unread && "font-semibold text-fg")}>
        <span className="flex items-center gap-1.5">
          {c.unread && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-accent" />}
          <span className="truncate">{c.title}</span>
          {c.unread && <span className="sr-only">{t("chat.list.unread")}</span>}
        </span>
        {c.snippet && <span className="mt-0.5 line-clamp-2 text-xs font-normal text-muted">{c.snippet}</span>}
      </Link>
      <div className={clsx("absolute right-1 top-1 flex items-center transition-opacity",
        "[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/row:opacity-100 [@media(hover:hover)]:group-focus-within/row:opacity-100")}>
        <RowButton label={c.pinned ? t("chat.list.unpin", { title: c.title }) : t("chat.list.pin", { title: c.title })} onClick={() => void onPin(c.id, !c.pinned)}>
          {c.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
        </RowButton>
        <RowButton label={t("chat.list.rename", { title: c.title })} onClick={() => setMode("rename")}><Pencil className="size-3.5" /></RowButton>
        <RowButton label={t("chat.list.deleteLabel", { title: c.title })} onClick={() => setMode("delete")} disabled={busy}><Trash2 className="size-3.5" /></RowButton>
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
