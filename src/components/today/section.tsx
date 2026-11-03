import type { ReactNode } from "react";
import { clsx } from "clsx";

/** A titled block on the Today page. Sits on the ground; no box. */
export function TodaySection({ id, title, action, children, className }: { id: string; title: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section aria-labelledby={`${id}-title`} className={clsx("min-w-0", className)}>
      <div className="mb-2.5 flex min-h-8 items-center justify-between gap-3">
        <h2 id={`${id}-title`} className="text-lg font-semibold tracking-[-0.01em]">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Shown when one part of the page couldn't load; the rest of the page keeps working. */
export function SectionError({ what, className }: { what: string; className?: string }) {
  return (
    <p role="status" className={clsx("rounded-lg bg-warn-tint px-3 py-2.5 text-sm text-warn", className)}>
      <span className="font-medium">Couldn&apos;t load {what}.</span> The rest of the page still works, so try reloading in a moment.
    </p>
  );
}

/** Href helpers. The target pages belong to other workstreams. */
export const hrefs = {
  node: (id: string) => `/node/${id}`,
  source: (id: string) => `/library/${id}`,
  wiki: (slug: string) => `/wiki/${encodeURIComponent(slug)}`,
  newWiki: "/wiki/new",
  upload: "/library?upload=1",
  library: "/library",
  wikiIndex: "/wiki",
  failedUploads: "/library?status=failed",
  chat: "/chat",
  timeline: "/timeline",
  ask: (q: string) => `/chat?q=${encodeURIComponent(q)}`,
  merges: "/graph?view=merge",
};
