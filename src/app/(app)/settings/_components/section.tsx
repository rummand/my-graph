import type { ReactNode } from "react";
import { Card } from "@/components/ui";

/** A titled settings card. */
export function Section({ id, title, lead, children, actions }: { id: string; title: string; lead?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section aria-labelledby={id} className="mb-6">
      <Card>
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id={id} className="text-base font-semibold">{title}</h2>
            {lead && <p className="mt-1 max-w-prose text-sm text-muted">{lead}</p>}
          </div>
          {actions}
        </div>
        {children}
      </Card>
    </section>
  );
}

export function Badge({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "accent" | "warn" | "danger" }) {
  const cls = {
    muted: "bg-surface-2 text-muted", accent: "bg-accent-tint text-accent", warn: "bg-surface-2 text-warn", danger: "bg-surface-2 text-danger",
  }[tone];
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{children}</span>;
}
