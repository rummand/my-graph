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

export { SectionError } from "./section-error";

/** Href helpers. The target pages belong to other workstreams. */
export const hrefs = {
  node: (id: string) => `/node/${id}`,
  source: (id: string) => `/library/${id}`,
  wiki: (slug: string) => `/artifacts/pages/${encodeURIComponent(slug)}`,
  newWiki: "/artifacts/pages/new",
  upload: "/library?upload=1",
  library: "/library",
  wikiIndex: "/artifacts/pages",
  failedUploads: "/library?status=failed",
  chat: "/chat",
  timeline: "/timeline",
  ask: (q: string) => `/chat?q=${encodeURIComponent(q)}`,
  merges: "/graph?view=merge",
  changeSet: (id: string) => `/changes/${encodeURIComponent(id)}`,
};
