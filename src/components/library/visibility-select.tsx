"use client";
import { useId } from "react";
import { ShieldAlert } from "lucide-react";
import { VISIBILITY_OPTIONS, type Visibility } from "./source-meta";

export function VisibilitySelect({ value, onChange, label = "Who can see this", disabled }: { value: Visibility; onChange: (v: Visibility) => void; label?: string; disabled?: boolean }) {
  const id = useId();
  const hint = VISIBILITY_OPTIONS.find((o) => o.value === value)?.hint;
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium">{label}</label>
      <select id={id} value={value} disabled={disabled} aria-describedby={`${id}-hint`}
        onChange={(e) => onChange(e.target.value as Visibility)}
        className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm disabled:opacity-60">
        {VISIBILITY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <p id={`${id}-hint`} className="mt-1 text-xs text-muted">{hint}</p>
    </div>
  );
}

export function SensitiveToggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="flex items-start gap-3 rounded-md border border-line p-3">
      <input id={id} type="checkbox" role="switch" aria-checked={checked} checked={checked} disabled={disabled}
        onChange={(e) => onChange(e.target.checked)} aria-describedby={`${id}-hint`}
        className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]" />
      <div className="min-w-0">
        <label htmlFor={id} className="flex items-center gap-1.5 text-sm font-medium"><ShieldAlert aria-hidden className="size-4 text-warn" />Sensitive</label>
        <p id={`${id}-hint`} className="mt-0.5 text-xs text-muted">Health, money or legal papers. Only processed by local models, never sent to cloud AI, and hidden from children.</p>
      </div>
    </div>
  );
}
