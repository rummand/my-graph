import { clsx } from "clsx";
import { CitationChip } from "@/components/ui";
import { formatDate, locatorLabel, percentSure, provenanceByline, type ProvenanceView } from "./labels";

/**
 * "Why do we believe this?": every record behind a node or fact. Each record leads with its source as a cobalt
 * citation, then the passage it came from, then who recorded it, how, and when. Server-safe (no hooks).
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
      {title && <H className="mb-3 font-semibold">{title}</H>}
      {items.length === 0 ? (
        <p className="text-sm text-muted">{emptyText}</p>
      ) : (
        <ol className="space-y-4">
          {items.map((p, i) => <ProvenanceItem key={p.id} n={i + 1} p={p} agents={agents} />)}
        </ol>
      )}
    </section>
  );
}

function ProvenanceItem({ n, p, agents }: { n: number; p: ProvenanceView; agents: Record<string, string> }) {
  const where = locatorLabel(p.locator);
  const title = p.sourceTitle ?? (p.activity === "manual_edit" ? "Entered by hand" : "No source document");
  const low = p.confidence < 0.6;
  const href = p.sourceId ? `/library/${p.sourceId}${typeof p.locator?.page === "number" ? `#page=${p.locator.page}` : ""}` : undefined;
  return (
    <li className="min-w-0 text-sm">
      <div className="flex items-baseline justify-between gap-3">
        <CitationChip n={n} title={title} detail={where || undefined} confidence={p.confidence} href={href} />
        <span className={clsx("shrink-0 text-xs tabular-nums", low ? "font-medium text-warn" : "text-muted")}
          title={low ? "Low confidence: worth checking" : undefined}>{percentSure(p.confidence)}</span>
      </div>
      {p.quote && (
        <blockquote className="mt-2 break-words border-l border-line pl-3 text-[15px]/6 text-fg">
          &ldquo;{p.quote}&rdquo;
        </blockquote>
      )}
      {p.note && <p className="mt-1.5 break-words text-fg/85">{p.note}</p>}
      <p className="mt-1.5 text-xs text-muted">
        {provenanceByline(p.activity, p.agentType, p.agentId, agents)}, <time dateTime={new Date(p.createdAt).toISOString()}>{formatDate(p.createdAt)}</time>
      </p>
    </li>
  );
}
