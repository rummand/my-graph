"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { MoreHorizontal } from "lucide-react";
import { clsx } from "clsx";
import { useT } from "@/lib/i18n/client";

export type MenuItem = { label: string; icon: ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean; hint?: string };

/** A small menu of conversation actions (pin, mark unread, compact, rename, delete). */
export function ThreadMenu({ items, label: given }: { items: MenuItem[]; label?: string }) {
  const t = useT();
  const label = given ?? t("chat.thread.actions");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); buttonRef.current?.focus(); } };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    // Focus the first item for keyboard users.
    ref.current?.querySelector<HTMLButtonElement>("[role=menuitem]:not([disabled])")?.focus();
    return () => { window.removeEventListener("pointerdown", onDown); window.removeEventListener("keydown", onKey); };
  }, [open]);

  function onMenuKey(e: React.KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const els = [...(ref.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not([disabled])") ?? [])];
    const i = els.indexOf(document.activeElement as HTMLButtonElement);
    els[(i + (e.key === "ArrowDown" ? 1 : -1) + els.length) % els.length]?.focus();
  }

  return (
    <div ref={ref} className="relative">
      <button ref={buttonRef} type="button" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        className="inline-flex size-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg">
        <MoreHorizontal aria-hidden className="size-4" />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div role="menu" aria-label={label} onKeyDown={onMenuKey}
            initial={{ opacity: 0, y: -4, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.15, ease: [0.22, 1, 0.36, 1] }}
            className="absolute right-0 top-9 z-40 w-64 origin-top-right rounded-lg bg-surface p-1 shadow-float">
            {items.map((it) => (
              <button key={it.label} type="button" role="menuitem" disabled={it.disabled}
                onClick={() => { setOpen(false); it.onSelect(); }}
                className={clsx("flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none disabled:opacity-50 [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0",
                  it.danger ? "text-danger" : "text-fg")}>
                <span aria-hidden className={it.danger ? "" : "text-muted"}>{it.icon}</span>
                <span className="min-w-0">
                  <span className="block">{it.label}</span>
                  {it.hint && <span className="block text-xs text-muted">{it.hint}</span>}
                </span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
