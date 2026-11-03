import { CitationChip } from "@/components/ui";
import { activityLabel, agentLabel, confidenceLabel, formatDate, locatorLabel, type ProvenanceView } from "./labels";

/**
 * "Why do we believe this?" — every record behind a node or fact: the source and passage, how it was read, who or
 * what recorded it, how sure we are, and when. Server-safe (no hooks); usable from client components too.
 */
export function ProvenancePanel({
  items, agents = {}, title = "Why do we believe this?", headingLevel = 2, emptyText = "Nothing recorded yet.", className,
}: {
  items: ProvenanceView[];
  /** user id → display name, for records entered by people. */
  agents?: Record<string, string>;
  title?: string | null;
  headingLevel?: 2 | 3 | 4;
  emptyText?: string;
  className?: string;
}) {
  const H = `h${headingLevel}` as "h2" | "h3" | "h4";
  return (
    <section className={className} aria-label={title ?? "Sources"}>
      {title && <H className="mb-3 text-sm font-semibold">{title}</H>}
      {items.length === 0 ? (
        <p className="text-sm text-muted">{emptyText}</p>
      ) : (
        <ol className="space-y-3">
          {items.map((p, i) => (
            <ProvenanceItem key={p.id} n={i + 1} p={p} agents={agents} />
          ))}
        </ol>
      )}
    </section>
  );
}

function ProvenanceItem({ n, p, agents }: { n: number; p: ProvenanceView; agents: Record<string, string> }) {
  const where = locatorLabel(p.locator);
  const title = p.sourceTitle ?? (p.activity === "manual_edit" ? "Entered by hand" : "No source document");
  return (
    <li className="rounded-md border border-line bg-surface p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <CitationChip n={n} title={title} detail={where || undefined} confidence={p.confidence}
          href={p.sourceId ? `/library/${p.sourceId}${typeof p.locator?.page === "number" ? `#page=${p.locator.page}` : ""}` : undefined} />
        <span className={p.confidence < 0.6 ? "text-xs text-warn" : "text-xs text-muted"}>{confidenceLabel(p.confidence)}</span>
      </div>
      {p.quote && (
        <blockquote className="mt-2 border-l-2 border-line pl-3 text-fg/90 italic break-words">“{p.quote}”</blockquote>
      )}
      {p.note && <p className="mt-2 text-muted break-words">{p.note}</p>}
      <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs text-muted">
        <dt>How</dt><dd className="text-fg">{activityLabel(p.activity)}</dd>
        <dt>By</dt><dd className="text-fg break-words">{agentLabel(p.agentType, p.agentId, agents)}</dd>
        {where && (<><dt>Where</dt><dd className="text-fg">{where}</dd></>)}
        <dt>When</dt><dd className="text-fg"><time dateTime={new Date(p.createdAt).toISOString()}>{formatDate(p.createdAt)}</time></dd>
      </dl>
    </li>
  );
}
