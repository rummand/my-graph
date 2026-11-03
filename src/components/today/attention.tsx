import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { CitationChip, Card } from "@/components/ui";
import type { TodayData } from "@/lib/briefs";
import { hrefs, SectionError, TodaySection } from "./section";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Unconfirmed low-confidence facts, failed uploads and possible duplicates. */
export function NeedsAttention({ data }: { data: Pick<TodayData, "attention" | "failedUploads" | "mergeSuggestions"> }) {
  const { attention, failedUploads, mergeSuggestions } = data;
  const facts = attention.ok ? attention.data.facts : [];
  const factTotal = attention.ok ? attention.data.total : 0;
  const failed = failedUploads.ok ? failedUploads.data : { items: [], total: 0 };
  const merges = mergeSuggestions ?? 0;
  const nothing = attention.ok && failedUploads.ok && factTotal === 0 && failed.total === 0 && merges === 0;

  return (
    <TodaySection id="attention" title="Needs your attention">
      {nothing ? (
        <Card className="text-sm text-muted">Nothing needs you right now. New facts the assistant isn&apos;t sure about will show up here.</Card>
      ) : (
        <Card className="space-y-4 text-sm">
          {!attention.ok && <SectionError what="facts to check" />}
          {facts.length > 0 && (
            <div>
              <p className="font-medium">
                {plural(factTotal, "fact to check", "facts to check")}
                <span className="font-normal text-muted"> — read from your documents, but we&apos;re not sure</span>
              </p>
              <ul className="mt-2 space-y-2">
                {facts.map((f) => (
                  <li key={f.edgeId} className="min-w-0">
                    <Link href={hrefs.node(f.fromId)} className="font-medium hover:underline">{f.text}</Link>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                      <CitationChip
                        title={f.sourceTitle ?? "No source shown"}
                        detail={f.page ? `p${f.page}` : undefined}
                        confidence={f.confidence}
                        href={f.sourceId ? hrefs.source(f.sourceId) : undefined}
                      />
                      <Link href={hrefs.node(f.fromId)} className="text-xs text-accent hover:underline">Confirm or correct</Link>
                    </div>
                  </li>
                ))}
              </ul>
              {factTotal > facts.length && <p className="mt-2 text-xs text-muted">and {factTotal - facts.length} more</p>}
            </div>
          )}

          {!failedUploads.ok && <SectionError what="upload status" />}
          {failed.total > 0 && (
            <div>
              <p className="flex items-center gap-1.5 font-medium text-warn">
                <AlertTriangle aria-hidden className="size-4" />
                {plural(failed.total, "upload couldn't be read", "uploads couldn't be read")}
              </p>
              <ul className="mt-1 space-y-1">
                {failed.items.map((s) => (
                  <li key={s.id} className="min-w-0">
                    <Link href={hrefs.source(s.id)} className="block truncate hover:underline">{s.title}</Link>
                    {s.error && <span className="block truncate text-xs text-muted">{s.error}</span>}
                  </li>
                ))}
              </ul>
              <Link href={hrefs.failedUploads} className="mt-1 inline-block text-xs text-accent hover:underline">Retry in the library</Link>
            </div>
          )}

          {merges > 0 && (
            <p>
              <Link href={hrefs.merges} className="font-medium text-accent hover:underline">
                {plural(merges, "possible duplicate", "possible duplicates")}
              </Link>
              <span className="text-muted"> — the same person or place may be in your graph twice.</span>
            </p>
          )}
        </Card>
      )}
    </TodaySection>
  );
}
