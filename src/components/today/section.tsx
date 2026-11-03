import type { ReactNode } from "react";
import { clsx } from "clsx";

/** A titled block on the Today page. */
export function TodaySection({ id, title, action, children, className }: { id: string; title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section aria-labelledby={`${id}-title`} className={clsx("min-w-0", className)}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id={`${id}-title`} className="text-base font-semibold tracking-tight">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Shown when one part of the page couldn't load; the rest of the page keeps working. */
export function SectionError({ what }: { what: string }) {
  return (
    <div role="status" className="rounded-lg border border-dashed border-line p-4 text-sm text-muted">
      <span className="font-medium text-warn">Couldn&apos;t load {what}.</span> The rest of the page still works — try reloading in a moment.
    </div>
  );
}

/** Href helpers — the target pages belong to other workstreams. */
export const hrefs = {
  node: (id: string) => `/node/${id}`,
  source: (id: string) => `/library/${id}`,
  wiki: (slug: string) => `/wiki/${encodeURIComponent(slug)}`,
  newWiki: "/wiki/new",
  upload: "/library?upload=1",
  library: "/library",
  failedUploads: "/library?status=failed",
  chat: "/chat",
  ask: (q: string) => `/chat?q=${encodeURIComponent(q)}`,
  merges: "/graph?view=merge",
};
