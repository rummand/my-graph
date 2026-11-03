import { clsx } from "clsx";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";

export function Button({ variant = "primary", className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger" }) {
  return <button {...p} className={clsx(
    "inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition disabled:opacity-50",
    variant === "primary" && "bg-accent text-accent-fg hover:opacity-90",
    variant === "secondary" && "border border-line bg-surface hover:bg-surface-2",
    variant === "ghost" && "text-muted hover:bg-surface-2 hover:text-fg",
    variant === "danger" && "bg-danger text-white hover:opacity-90",
    className)} />;
}

export function Input({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...p} className={clsx("w-full rounded-md border border-line bg-surface px-3 py-2 text-sm placeholder:text-muted", className)} />;
}

export function Textarea({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...p} className={clsx("w-full rounded-md border border-line bg-surface px-3 py-2 text-sm placeholder:text-muted", className)} />;
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={clsx("rounded-lg border border-line bg-surface p-4", className)}>{children}</div>;
}

export function PageHeader({ title, lead, actions }: { title: string; lead?: string; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {lead && <p className="mt-1 max-w-prose text-sm text-muted">{lead}</p>}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </header>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line p-8 text-center">
      <p className="font-medium">{title}</p>
      {children && <div className="mt-2 text-sm text-muted">{children}</div>}
    </div>
  );
}

const TYPE_VAR: Record<string, string> = { person: "--t-person", place: "--t-place", event: "--t-event", topic: "--t-topic", document: "--t-document", source: "--t-source" };

/** A node chip coloured by type. */
export function NodeChip({ type, label, href }: { type: string; label: string; href?: string }) {
  const style = { color: `var(${TYPE_VAR[type] ?? "--muted"})`, borderColor: `var(${TYPE_VAR[type] ?? "--line"})` };
  const cls = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium";
  return href ? <a href={href} className={cls} style={style}>{label}</a> : <span className={cls} style={style}>{label}</span>;
}

/** Provenance citation chip: "[n] title · p2 · 0.94" — the signature element of My Graph. */
export function CitationChip({ n, title, detail, confidence, href }: { n?: number; title: string; detail?: string; confidence?: number; href?: string }) {
  const low = confidence !== undefined && confidence < 0.6;
  const body = (
    <span className={clsx("inline-flex max-w-full items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px] align-baseline",
      low ? "bg-surface-2 text-warn" : "bg-accent-tint text-accent")}>
      {n !== undefined && <span>[{n}]</span>}
      <span className="truncate">{title}</span>
      {detail && <span className="opacity-70">· {detail}</span>}
      {confidence !== undefined && <span className="opacity-70">· {confidence.toFixed(2)}</span>}
    </span>
  );
  return href ? <a href={href} title={title}>{body}</a> : body;
}
