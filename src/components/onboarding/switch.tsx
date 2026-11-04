"use client";
import { clsx } from "clsx";
import { motion } from "motion/react";

/** An on/off switch. Ink when on, grey when off. (Candidate for src/components/ui.) */
export function Switch({ checked, onChange, label, disabled, busy }: {
  checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean; busy?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-busy={busy || undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        "relative inline-flex h-6 w-10 shrink-0 items-center rounded-full p-0.5 transition-colors duration-150 disabled:opacity-45",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface",
        checked ? "bg-fg" : "bg-line",
        busy && "opacity-70",
      )}
    >
      <motion.span
        layout
        className="block size-5 rounded-full bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.2)]"
        style={{ marginLeft: checked ? "auto" : 0 }}
      />
    </button>
  );
}
