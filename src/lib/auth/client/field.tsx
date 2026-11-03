import type { ReactNode } from "react";

/** Label + control + hint/error, wired up for screen readers. The control should use `id` and `describedBy(id, …)`. */
export function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: ReactNode; error?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium">{label}</label>
      {children}
      {hint && !error && <p id={`${id}-hint`} className="mt-1 text-xs text-muted">{hint}</p>}
      {error && <p id={`${id}-err`} className="mt-1 text-xs text-danger" role="alert">{error}</p>}
    </div>
  );
}

export function describedBy(id: string, error?: string, hint?: boolean): string | undefined {
  if (error) return `${id}-err`;
  return hint ? `${id}-hint` : undefined;
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return <p role="alert" className="rounded-md border border-danger/40 bg-surface-2 px-3 py-2 text-sm text-danger">{message}</p>;
}

export function FormNotice({ message }: { message: string | null }) {
  if (!message) return null;
  return <p role="status" className="rounded-md bg-accent-tint px-3 py-2 text-sm text-accent">{message}</p>;
}
