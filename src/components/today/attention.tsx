import Link from "next/link";
import { CircleCheck, Copy, FileWarning } from "lucide-react";
import { CitationChip } from "@/components/ui";
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
  const count = factTotal + failed.total + merges;
  const nothing = attention.ok && failedUploads.ok && count === 0;

  return (
    <TodaySection
      id="attention"
      title={<>Needs you{count > 0 && <span className="ml-2 rounded-full bg-warn-tint px-2 py-0.5 align-middle text-xs font-medium tabular-nums text-warn">{count}</span>}</>}
    >
      {nothing ? (
        <p className="flex items-start gap-2 text-sm text-muted">
          <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0" />
          Nothing to check. Facts the assistant isn&apos;t sure about will wait here for you.
        </p>
      ) : (
        <div className="space-y-2">
          {!attention.ok && <SectionError what="facts to check" />}
          {facts.length > 0 && (
            <div className="rounded-lg bg-surface px-4 py-3">
              <p className="text-sm text-muted">
                {plural(factTotal, "fact", "facts")} read from your files that the assistant isn&apos;t sure about
              </p>
              <ul className="mt-1">
                {facts.map((f) => (
                  <li key={f.edgeId} className="border-t border-line/70 py-2.5 first:border-0">
                    <Link href={hrefs.node(f.fromId)} className="font-medium hover:underline">{f.text}</Link>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                      <CitationChip
                        title={f.sourceTitle ?? "No source shown"}
                        detail={f.page ? `p. ${f.page}` : undefined}
                        confidence={f.confidence}
                        href={f.sourceId ? hrefs.source(f.sourceId) : undefined}
                      />
                      <Link href={hrefs.node(f.fromId)} className="text-sm text-accent hover:underline">Confirm or correct</Link>
                    </div>
                  </li>
                ))}
              </ul>
              {factTotal > facts.length && <p className="pb-1 text-sm text-muted">and {factTotal - facts.length} more</p>}
            </div>
          )}

          {!failedUploads.ok && <SectionError what="upload status" />}
          {failed.total > 0 && (
            <div className="rounded-lg bg-surface px-4 py-3">
              <p className="flex items-center gap-2 font-medium text-warn">
                <FileWarning aria-hidden className="size-4" />
                {plural(failed.total, "upload couldn't be read", "uploads couldn't be read")}
              </p>
              <ul className="mt-1.5 space-y-1.5 text-sm">
                {failed.items.map((s) => (
                  <li key={s.id} className="min-w-0">
                    <Link href={hrefs.source(s.id)} className="block truncate hover:underline">{s.title}</Link>
                    {s.error && <span className="block truncate text-muted">{s.error}</span>}
                  </li>
                ))}
              </ul>
              <Link href={hrefs.failedUploads} className="mt-2 inline-block text-sm text-accent hover:underline">Try again in the library</Link>
            </div>
          )}

          {merges > 0 && (
            <Link href={hrefs.merges} className="group flex items-start gap-3 rounded-lg bg-surface px-4 py-3 transition-colors hover:bg-surface/70">
              <Copy aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
              <span className="min-w-0">
                <span className="block font-medium group-hover:underline">{plural(merges, "possible duplicate", "possible duplicates")}</span>
                <span className="block text-sm text-muted">The same person or place may be in your graph twice. Merge or keep apart.</span>
              </span>
            </Link>
          )}
        </div>
      )}
    </TodaySection>
  );
}
