"use client";
import { useId, type KeyboardEvent } from "react";
import { clsx } from "clsx";
import { Lock, ShieldAlert, Users, UsersRound } from "lucide-react";
import { VISIBILITY_OPTIONS, type Visibility } from "./source-meta";

const ICON: Record<Visibility, typeof Lock> = { private: Lock, parents: UsersRound, household: Users };

/** Who can see a file: three choices side by side, the current one raised. A real radio group for keyboards. */
export function VisibilitySelect({ value, onChange, label = "Who can see this", disabled, compact = false }: {
  value: Visibility; onChange: (v: Visibility) => void; label?: string; disabled?: boolean; compact?: boolean;
}) {
  const id = useId();
  const hint = VISIBILITY_OPTIONS.find((o) => o.value === value)?.hint;
  const move = (e: KeyboardEvent, dir: 1 | -1) => {
    e.preventDefault();
    const i = VISIBILITY_OPTIONS.findIndex((o) => o.value === value);
    const next = VISIBILITY_OPTIONS[(i + dir + VISIBILITY_OPTIONS.length) % VISIBILITY_OPTIONS.length];
    onChange(next.value);
    document.getElementById(`${id}-${next.value}`)?.focus();
  };
  return (
    <div>
      <p id={`${id}-label`} className={clsx("mb-1.5 text-sm font-medium", compact && "sr-only")}>{label}</p>
      <div role="radiogroup" aria-labelledby={`${id}-label`} aria-describedby={compact ? undefined : `${id}-hint`}
        className={clsx("inline-flex max-w-full rounded-md bg-surface-2 p-0.5", disabled && "opacity-60")}>
        {VISIBILITY_OPTIONS.map((o) => {
          const on = o.value === value;
          const Icon = ICON[o.value];
          return (
            <button key={o.value} id={`${id}-${o.value}`} type="button" role="radio" aria-checked={on} disabled={disabled}
              tabIndex={on ? 0 : -1} title={o.hint}
              onClick={() => onChange(o.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight" || e.key === "ArrowDown") move(e, 1);
                if (e.key === "ArrowLeft" || e.key === "ArrowUp") move(e, -1);
              }}
              className={clsx("inline-flex h-8 min-w-0 items-center gap-1.5 rounded-[5px] px-2.5 text-sm transition-colors duration-150",
                on ? "bg-surface font-medium text-fg shadow-[0_1px_2px_rgb(0_0_0/0.08)]" : "text-muted hover:text-fg")}>
              <Icon aria-hidden className="size-3.5 shrink-0" />
              <span className="truncate">{o.label}</span>
            </button>
          );
        })}
      </div>
      {!compact && <p id={`${id}-hint`} className="mt-1.5 text-sm text-muted">{hint}</p>}
    </div>
  );
}

/** An on/off switch for "sensitive": health, money and legal papers stay on local models. */
export function SensitiveToggle({ checked, onChange, disabled, compact = false }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; compact?: boolean }) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <button id={id} type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}
        aria-describedby={compact ? undefined : `${id}-hint`}
        className={clsx("relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-150 disabled:opacity-50",
          checked ? "bg-warn" : "bg-line")}>
        <span aria-hidden className={clsx("absolute left-0.5 size-4 rounded-full bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.2)] transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]",
          checked && "translate-x-4")} />
      </button>
      <div className="min-w-0">
        <label htmlFor={id} className="flex cursor-pointer items-center gap-1.5 text-sm font-medium">
          Sensitive{checked && <ShieldAlert aria-hidden className="size-3.5 text-warn" />}
        </label>
        {!compact && (
          <p id={`${id}-hint`} className="mt-0.5 text-sm text-muted">Health, money or legal papers. Read only by models in the house, never sent to cloud AI, and hidden from children.</p>
        )}
      </div>
    </div>
  );
}
