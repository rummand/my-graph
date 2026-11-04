import type { Receipt } from "@/lib/changes";
import type { TFn } from "@/lib/i18n/core";
import { CitationChip } from "@/components/ui";

/**
 * Where one change came from, as a chip a person can follow: the document (with the passage), the conversation, or the
 * web page; plus the quoted words and how sure the agent was. Server- and client-safe.
 */
export function ReceiptLine({ r, t, sourceTitle, className }: { r: Receipt; t: TFn; sourceTitle?: string | null; className?: string }) {
  const sure = typeof r.confidence === "number" ? Math.max(0, Math.min(1, r.confidence)) : undefined;
  let chip: React.ReactNode = null;
  if (r.sourceId) {
    chip = <CitationChip title={sourceTitle ? t("changes.receipt.source", { title: sourceTitle }) : t("changes.receipt.sourceUntitled")} confidence={sure} href={`/library/${r.sourceId}`} />;
  } else if (r.conversationId) {
    chip = <CitationChip title={t("changes.receipt.conversation")} confidence={sure} href={`/chat/${r.conversationId}`} />;
  } else if (r.url && /^https?:\/\//.test(r.url)) {
    let host = r.url;
    try { host = new URL(r.url).hostname.replace(/^www\./, ""); } catch { /* keep the url */ }
    chip = <a href={r.url} rel="noreferrer noopener" target="_blank"><CitationChip title={host} confidence={sure} /></a>;
  }
  if (!chip && !r.quote && sure === undefined) return null;
  return (
    <div className={className ?? "mt-2 text-sm"}>
      {r.quote && <blockquote className="max-w-[65ch] break-words border-l-2 border-accent/40 pl-3 text-fg/90">&ldquo;{r.quote}&rdquo;</blockquote>}
      <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        {chip}
        {sure !== undefined && <span className="tabular-nums">{t("changes.receipt.sure", { pct: Math.round(sure * 100) })}</span>}
      </p>
    </div>
  );
}
