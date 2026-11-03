import Link from "next/link";
import { FileText } from "lucide-react";
import { NodeChip, PersonChip } from "@/components/ui";
import type { Backlinks } from "@/lib/wiki";

/** Pages that point here, and the graph nodes this page mentions. */
export function BacklinksPanel({ backlinks, nodeId }: { backlinks: Backlinks; nodeId: string | null }) {
  return (
    <>
      <section aria-labelledby="wiki-backlinks">
        <h2 id="wiki-backlinks" className="mb-2 text-sm font-semibold">Linked from</h2>
        {backlinks.pages.length === 0 ? (
          <p className="text-sm text-muted">No other page links here yet. Type [[ on another page to link to this one.</p>
        ) : (
          <ul className="space-y-1.5">
            {backlinks.pages.map((p) => (
              <li key={p.id} className="flex items-start gap-2 text-sm">
                <FileText aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
                <span className="min-w-0">
                  <Link href={`/wiki/${encodeURIComponent(p.slug)}`} className="break-words text-accent hover:underline">{p.title}</Link>
                  {p.via === "mention" && <span className="text-muted"> (mentions this page)</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="wiki-mentions">
        <h2 id="wiki-mentions" className="mb-2 text-sm font-semibold">Mentioned on this page</h2>
        {backlinks.mentions.length === 0 ? (
          <p className="text-sm text-muted">No people, places or events mentioned. Type @ while editing to mention one.</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {backlinks.mentions.map((m) => (
              <li key={m.id}>{m.type === "person"
                ? <PersonChip id={m.id} name={m.label} href={m.readable ? `/people/${m.id}` : undefined} />
                : <NodeChip type={m.type} label={m.label} href={m.readable ? `/node/${m.id}` : undefined} />}</li>
            ))}
          </ul>
        )}
        {nodeId && (
          <p className="mt-3 text-xs text-muted"><Link href={`/node/${nodeId}`} className="hover:text-fg hover:underline">See this page in the graph</Link></p>
        )}
      </section>
    </>
  );
}
