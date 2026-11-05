"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { clsx } from "clsx";

/**
 * A small floating layer opened by a button (snooze times, who does it, why drop it). Closes on Escape, on a click
 * outside, or when `close()` is called from inside. Focus goes to the first item and back to the button.
 */
export function Pop({ label, button, children, align = "right", className }: {
  label: string;
  button: (p: { open: boolean; toggle: () => void; ref: React.RefObject<HTMLButtonElement | null> }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); buttonRef.current?.focus(); } };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    ref.current?.querySelector<HTMLElement>("[role=menuitem]:not([disabled]), input, select, textarea")?.focus();
    return () => { window.removeEventListener("pointerdown", onDown); window.removeEventListener("keydown", onKey); };
  }, [open]);
  const onMenuKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const els = [...(ref.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not([disabled])") ?? [])];
    if (!els.length) return;
    e.preventDefault();
    const i = els.indexOf(document.activeElement as HTMLButtonElement);
    els[(i + (e.key === "ArrowDown" ? 1 : -1) + els.length) % els.length]?.focus();
  };
  return (
    <div ref={ref} className="relative">
      {button({ open, toggle: () => setOpen((o) => !o), ref: buttonRef })}
      <AnimatePresence>
        {open && (
          <motion.div role="menu" aria-label={label} onKeyDown={onMenuKey}
            initial={{ opacity: 0, y: -4, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.15, ease: [0.22, 1, 0.36, 1] }}
            className={clsx("absolute top-9 z-40 w-64 rounded-lg bg-surface p-1 shadow-float", align === "right" ? "right-0 origin-top-right" : "left-0 origin-top-left", className)}>
            <p className="px-2.5 pb-1 pt-1.5 text-xs text-muted">{label}</p>
            {children(() => { setOpen(false); buttonRef.current?.focus(); })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function MenuItem({ children, onSelect, icon, hint, danger, disabled }: { children: ReactNode; onSelect: () => void; icon?: ReactNode; hint?: string; danger?: boolean; disabled?: boolean }) {
  return (
    <button type="button" role="menuitem" disabled={disabled} onClick={onSelect}
      className={clsx("flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none disabled:opacity-50",
        danger ? "text-danger" : "text-fg")}>
      {icon && <span aria-hidden className={clsx("mt-0.5 shrink-0 [&_svg]:size-4", danger ? "" : "text-muted")}>{icon}</span>}
      <span className="min-w-0">
        <span className="block">{children}</span>
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
    </button>
  );
}
