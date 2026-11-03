import { clsx } from "clsx";
import type { ReactNode } from "react";

/**
 * One settings topic: what it is on the left, the controls on a surface on the right.
 * Stacks on narrower screens. No outline; the surface tone does the separating.
 */
export function Row({ id, title, lead, aside, asideFirst, children, tone = "surface", flush }: {
  id: string; title: ReactNode; lead?: ReactNode; children: ReactNode;
  /** Help or a preview of the result, under the title on wide screens. On narrow ones it follows the panel, or precedes it with `asideFirst`. */
  aside?: ReactNode; asideFirst?: boolean;
  tone?: "surface" | "warn"; flush?: boolean;
}) {
  return (
    <section aria-labelledby={id} className="grid gap-4 py-8 first-of-type:pt-0 xl:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] xl:grid-rows-[auto_1fr] xl:gap-x-10 xl:gap-y-4">
      <div className="min-w-0 xl:col-start-1 xl:row-start-1 xl:pt-4">
        <h2 id={id} className="text-base font-semibold">{title}</h2>
        {lead && <div className="mt-1 max-w-[52ch] text-sm text-muted">{lead}</div>}
      </div>
      <div className={clsx("min-w-0 rounded-lg xl:col-start-2 xl:row-span-2 xl:row-start-1 xl:self-start", asideFirst && "order-last xl:order-none", tone === "warn" ? "bg-warn-tint" : "bg-surface", !flush && "p-5")}>{children}</div>
      {aside && <div className="min-w-0 xl:col-start-1 xl:row-start-2">{aside}</div>}
    </section>
  );
}

/** The bottom strip of a panel: status on the left, the one action on the right. */
export function PanelFooter({ children, status, className }: { children: ReactNode; status?: ReactNode; className?: string }) {
  return (
    <div className={clsx("mt-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-3", className)}>
      <div className="min-w-0 flex-1">{status}</div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}
