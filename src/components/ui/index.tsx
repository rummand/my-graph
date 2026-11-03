import { clsx } from "clsx";
import type {
  ButtonHTMLAttributes, CSSProperties, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes,
} from "react";
import { initials, personStyle } from "@/lib/ui/person-color";

/* Building blocks for every screen. See DESIGN.md: tone over outlines, ink for actions, cobalt for provenance. */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "accent";
const BUTTON = {
  base: "inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-[background-color,color,transform] duration-150 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-45",
  primary: "bg-fg text-bg hover:bg-fg/85",
  accent: "bg-accent text-accent-fg hover:bg-accent/90",
  secondary: "bg-surface text-fg ring-1 ring-inset ring-line hover:bg-surface-2",
  ghost: "text-muted hover:bg-surface-2 hover:text-fg",
  danger: "bg-danger text-white hover:bg-danger/90",
};

export function buttonClass(variant: ButtonVariant = "primary", size: "sm" | "md" = "md") {
  return clsx(BUTTON.base, BUTTON[variant], size === "sm" ? "h-8 px-2.5 text-sm" : "h-9 px-3.5 text-sm");
}

export function Button({ variant = "primary", size = "md", className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: "sm" | "md" }) {
  return <button {...p} className={clsx(buttonClass(variant, size), className)} />;
}

export function IconButton({ label, className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button aria-label={label} title={label} {...p}
    className={clsx("inline-flex size-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-45", className)} />;
}

const FIELD = "w-full rounded-md bg-surface px-3 text-[15px] text-fg ring-1 ring-inset ring-line transition-shadow placeholder:text-muted/80 hover:ring-muted/40 focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-60";

export function Input({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...p} className={clsx(FIELD, "h-9", className)} />;
}

export function Textarea({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...p} className={clsx(FIELD, "py-2 leading-relaxed", className)} />;
}

export function Select({ className, ...p }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...p} className={clsx(FIELD, "h-9 appearance-none bg-[length:16px] bg-[right_0.5rem_center] bg-no-repeat pr-8", className)}
    style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23858d88' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")", ...p.style }} />;
}

/** A label, the control, and an optional hint or error underneath. */
export function Field({ label, hint, error, children, className }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string }) {
  return (
    <label className={clsx("block", className)}>
      <span className="mb-1.5 block text-sm font-medium">{label}</span>
      {children}
      {error ? <span className="mt-1.5 block text-sm text-danger">{error}</span>
        : hint ? <span className="mt-1.5 block text-sm text-muted">{hint}</span> : null}
    </label>
  );
}

/** A raised area on the ground. No outline: separation comes from tone. */
export function Panel({ className, children, as: Tag = "div" }: { className?: string; children: ReactNode; as?: "div" | "section" | "article" | "aside" }) {
  return <Tag className={clsx("rounded-lg bg-surface p-4", className)}>{children}</Tag>;
}

/** Kept for existing screens; same as Panel. */
export const Card = Panel;

/** A titled part of a page. Sits on the ground, no box. */
export function Section({ title, action, children, className, id }: { title: ReactNode; action?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return (
    <section className={clsx("min-w-0", className)} aria-labelledby={id}>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 id={id} className="text-lg font-semibold tracking-[-0.01em]">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function PageHeader({ title, lead, actions }: { title: string; lead?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-8 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div className="min-w-0">
        <h1 className="text-[28px]/[1.15] font-semibold tracking-[-0.02em]">{title}</h1>
        {lead && <p className="mt-2 max-w-[60ch] text-muted">{lead}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function EmptyState({ title, children, action, icon }: { title: string; children?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-lg bg-surface-2/60 px-6 py-10 text-center">
      {icon && <div className="mb-3 text-muted">{icon}</div>}
      <p className="font-medium">{title}</p>
      {children && <div className="mt-1.5 max-w-[48ch] text-sm text-muted">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Badge({ tone = "neutral", children, className }: { tone?: "neutral" | "accent" | "warn" | "danger" | "inferred"; children: ReactNode; className?: string }) {
  return <span className={clsx("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
    tone === "neutral" && "bg-surface-2 text-muted",
    tone === "accent" && "bg-accent-tint text-accent",
    tone === "warn" && "bg-warn-tint text-warn",
    tone === "danger" && "bg-danger-tint text-danger",
    tone === "inferred" && "bg-inferred-tint text-inferred", className)}>{children}</span>;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded bg-surface-2 px-1.5 py-0.5 font-sans text-xs text-muted">{children}</kbd>;
}

/** Segmented tabs. Pass hrefs for navigation or onSelect for local state. */
export function Tabs<T extends string>({ items, value, onSelect, className }: { items: { value: T; label: ReactNode; href?: string }[]; value: T; onSelect?: (v: T) => void; className?: string }) {
  return (
    <div role="tablist" className={clsx("inline-flex rounded-md bg-surface-2 p-0.5", className)}>
      {items.map((it) => {
        const active = it.value === value;
        const cls = clsx("inline-flex h-8 items-center gap-1.5 rounded-[5px] px-3 text-sm transition-colors",
          active ? "bg-surface font-medium text-fg shadow-[0_1px_2px_rgb(0_0_0/0.08)]" : "text-muted hover:text-fg");
        return it.href
          ? <a key={it.value} role="tab" aria-selected={active} href={it.href} className={cls}>{it.label}</a>
          : <button key={it.value} type="button" role="tab" aria-selected={active} className={cls} onClick={() => onSelect?.(it.value)}>{it.label}</button>;
      })}
    </div>
  );
}

/** A person's round mark in their own colour. Pass the person's node id (or user id) so the colour is stable. */
export function Avatar({ id, name, size = 32, className }: { id: string; name: string; size?: number; className?: string }) {
  return (
    <span aria-hidden className={clsx("inline-flex shrink-0 items-center justify-center rounded-full font-semibold", className)}
      style={{ ...personStyle(id), width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.38)), background: "var(--person-tint)", color: "var(--person)" } as CSSProperties}>
      {initials(name)}
    </span>
  );
}

/** A person as a chip: their dot and name, in their colour. */
export function PersonChip({ id, name, href, className }: { id: string; name: string; href?: string; className?: string }) {
  const cls = clsx("inline-flex max-w-full items-center gap-1.5 rounded-full py-0.5 pl-1 pr-2.5 text-sm font-medium", href && "hover:brightness-95", className);
  const style = { ...personStyle(id), background: "var(--person-tint)", color: "var(--person)" } as CSSProperties;
  const body = <><span className="size-2 shrink-0 rounded-full bg-current ml-1" /><span className="truncate">{name}</span></>;
  return href ? <a href={href} className={cls} style={style}>{body}</a> : <span className={cls} style={style}>{body}</span>;
}

const TYPE_VAR: Record<string, string> = { person: "--t-person", place: "--t-place", event: "--t-event", topic: "--t-topic", document: "--t-document", source: "--t-source" };

/** A graph node as a chip, marked by its type colour. */
export function NodeChip({ type, label, href }: { type: string; label: string; href?: string }) {
  const style = { "--c": `var(${TYPE_VAR[type] ?? "--muted"})` } as CSSProperties;
  const cls = "inline-flex max-w-full items-center gap-1.5 rounded-full bg-surface-2 py-0.5 pl-2 pr-2.5 text-sm text-fg";
  const body = <><span className="size-1.5 shrink-0 rounded-full bg-[var(--c)]" /><span className="truncate">{label}</span></>;
  return href ? <a href={href} className={clsx(cls, "hover:bg-line")} style={style}>{body}</a> : <span className={cls} style={style}>{body}</span>;
}

/** Provenance citation: the signature mark of My Graph. A small cobalt superscript-like tag; low confidence turns amber. */
export function CitationChip({ n, title, detail, confidence, href }: { n?: number; title: string; detail?: string; confidence?: number; href?: string }) {
  const low = confidence !== undefined && confidence < 0.6;
  const tip = [title, detail, confidence !== undefined ? `${Math.round(confidence * 100)}% sure` : null].filter(Boolean).join(", ");
  const body = (
    <span title={tip} className={clsx("inline-flex max-w-[22ch] items-center gap-1 rounded-[4px] px-1.5 py-px align-baseline text-xs font-medium tabular-nums transition-colors",
      low ? "bg-warn-tint text-warn" : "bg-accent-tint text-accent", href && "hover:bg-accent hover:text-accent-fg")}>
      {n !== undefined && <span>{n}</span>}
      <span className="truncate">{title}</span>
      {detail && <span className="opacity-70">{detail}</span>}
    </span>
  );
  return href ? <a href={href}>{body}</a> : body;
}
