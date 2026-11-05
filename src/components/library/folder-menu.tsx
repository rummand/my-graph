"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { clsx } from "clsx";
import { Check, Folder, FolderInput, Inbox } from "lucide-react";
import type { Lx } from "./i18n";
import { flattenViews, type FolderView } from "./folder-client";

export type MenuItem = {
  key: string; label: string; icon?: ReactNode; onSelect: () => void;
  danger?: boolean; disabled?: boolean; checked?: boolean; indent?: number; hint?: string;
};

/**
 * A small menu: a trigger button and a floating list. Arrow keys move, Escape closes and gives focus back,
 * a click outside (or scrolling the page) closes it. Used for folder actions and "Move to…". The list is drawn on
 * top of the page (a portal, fixed in place) so a scrolling sidebar or a card never cuts it off.
 */
export function Menu({ label, trigger, items, align = "right", side = "bottom", className, triggerClassName, heading, width = 240 }: {
  label: string; trigger: ReactNode; items: MenuItem[]; align?: "left" | "right"; className?: string; triggerClassName?: string;
  heading?: string;
  /** Width in pixels. */
  width?: number;
  /** "top" opens upward (for a bar at the bottom of the screen); it also flips by itself when there is no room. */
  side?: "top" | "bottom";
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<React.CSSProperties | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();

  const place = () => {
    const r = button.current?.getBoundingClientRect();
    if (!r) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const left = Math.max(8, Math.min(align === "right" ? r.right - width : r.left, vw - width - 8));
    const below = vh - r.bottom - 12, above = r.top - 12;
    const up = side === "top" ? above > 160 || above > below : below < 220 && above > below;
    setPos(up
      ? { position: "fixed", left, bottom: vh - r.top + 4, width, maxHeight: Math.min(420, above) }
      : { position: "fixed", left, top: r.bottom + 4, width, maxHeight: Math.min(420, below) });
  };

  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !list.current?.contains(t)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); button.current?.focus(); } };
    const away = (e: Event) => { if (!list.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("pointerdown", down);
    window.addEventListener("keydown", key);
    window.addEventListener("scroll", away, true);
    window.addEventListener("resize", away);
    requestAnimationFrame(() => list.current?.querySelector<HTMLButtonElement>("[role=menuitem]:not([disabled])")?.focus());
    return () => {
      window.removeEventListener("pointerdown", down); window.removeEventListener("keydown", key);
      window.removeEventListener("scroll", away, true); window.removeEventListener("resize", away);
    };
  }, [open]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Tab") { setOpen(false); return; }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const els = [...(list.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not([disabled])") ?? [])];
    const i = els.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? els.length - 1 : (i + (e.key === "ArrowDown" ? 1 : -1) + els.length) % els.length;
    els[next]?.focus();
  };

  const up = pos?.bottom !== undefined;
  return (
    <div ref={ref} className={clsx("relative", className)}>
      <button ref={button} type="button" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (!open) place(); setOpen((o) => !o); }}
        className={clsx("inline-flex items-center justify-center rounded-md transition-colors", triggerClassName ?? "size-8 text-muted hover:bg-surface-2 hover:text-fg")}>
        {trigger}
      </button>
      {typeof document !== "undefined" && createPortal(
        <AnimatePresence>
          {open && pos && (
            <motion.div ref={list} id={id} role="menu" aria-label={label} onKeyDown={onKey} style={pos}
              initial={{ opacity: 0, y: up ? 4 : -4, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: up ? 4 : -4, scale: 0.98 }}
              transition={{ duration: 0.15, ease: [0.22, 1, 0.36, 1] }}
              className={clsx("z-50 overflow-y-auto rounded-lg bg-surface p-1 shadow-float",
                up ? (align === "right" ? "origin-bottom-right" : "origin-bottom-left") : align === "right" ? "origin-top-right" : "origin-top-left")}>
              {heading && <p className="px-2.5 pb-1 pt-1.5 text-xs text-muted">{heading}</p>}
              {items.map((it) => (
                <button key={it.key} type="button" role="menuitem" disabled={it.disabled} title={it.hint}
                  onClick={(e) => { e.stopPropagation(); setOpen(false); button.current?.focus(); it.onSelect(); }}
                  style={it.indent ? { paddingLeft: `${0.625 + it.indent * 0.875}rem` } : undefined}
                  className={clsx("flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
                    it.danger ? "text-danger" : "text-fg")}>
                  {it.icon && <span aria-hidden className={it.danger ? "" : "text-muted"}>{it.icon}</span>}
                  <span className="min-w-0 flex-1 truncate">{it.label}</span>
                  {it.checked && <Check aria-hidden className="text-muted" />}
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
}

/**
 * "Move to…": every folder the viewer can see, indented, plus "Not in a folder". `current` is where the file is now
 * (null = in none); `exclude` hides folders a folder can't move into (itself and what is inside it).
 */
export function MoveToMenu({ L, folders, current, onMove, label, exclude, topLabel, align = "right", side, trigger, triggerClassName, disabled, className }: {
  L: Lx; folders: FolderView[]; current: string | null; onMove: (folderId: string | null) => void; label: string;
  exclude?: Set<string>; topLabel?: string; align?: "left" | "right"; side?: "top" | "bottom"; trigger?: ReactNode; triggerClassName?: string; disabled?: boolean; className?: string;
}) {
  const { t } = L;
  const flat = flattenViews(folders).filter((f) => !exclude?.has(f.id));
  const items: MenuItem[] = [
    { key: "none", label: topLabel ?? t("library.folders.unfiled"), icon: <Inbox />, checked: current === null, disabled: current === null, onSelect: () => onMove(null) },
    ...flat.map((f) => ({
      key: f.id, label: f.name, icon: <Folder />, indent: f.depth - 1, checked: current === f.id, disabled: current === f.id || disabled, onSelect: () => onMove(f.id),
    })),
  ];
  return (
    <Menu label={label} heading={t("library.folders.moveTo")} items={items} align={align} side={side} width={256} className={className}
      trigger={trigger ?? <FolderInput aria-hidden className="size-4" />} triggerClassName={triggerClassName} />
  );
}
