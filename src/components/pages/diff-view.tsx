import { getT } from "@/lib/i18n";
import { collapseUnchanged, diffStats, wordDiff } from "@/lib/pages/diff";

/**
 * A readable word diff set in the reading face: added words on a cobalt tint, removed words struck through in brick,
 * long unchanged stretches folded to a short note so the changes are what you see.
 */
export async function DiffView({ before, after, beforeTitle, afterTitle }: { before: string; after: string; beforeTitle?: string; afterTitle?: string }) {
  const t = await getT();
  const segs = wordDiff(before, after);
  const stats = diffStats(segs);
  const shown = collapseUnchanged(segs, 15);
  const titleChanged = beforeTitle !== undefined && afterTitle !== undefined && beforeTitle !== afterTitle;
  const nothing = stats.added === 0 && stats.removed === 0 && !titleChanged;
  return (
    <div>
      <p className="mb-6 text-sm text-muted">
        {nothing ? t("pages.diff.nothing") : (
          <>
            {stats.added > 0 && <span className="font-medium text-accent">{t("pages.history.wordsAdded", { count: stats.added })}</span>}
            {stats.added > 0 && stats.removed > 0 && t("pages.diff.and")}
            {stats.removed > 0 && <span className="font-medium text-danger">{stats.added > 0 ? t("pages.history.removedShort", { count: stats.removed }) : t("pages.history.wordsRemoved", { count: stats.removed })}</span>}
            {(stats.added > 0 || stats.removed > 0) && "."}
            {titleChanged && <> {t("pages.diff.titleChanged", { from: beforeTitle ?? "", to: afterTitle ?? "" })}</>}
          </>
        )}
      </p>
      <div className="max-w-[68ch] whitespace-pre-wrap break-words font-read text-[17px] leading-[1.85]">
        {shown.length === 0 && <span className="text-muted">{t("pages.diff.empty")}</span>}
        {shown.map((s, i) => {
          if (s.op === "gap") {
            return (
              <span key={i} className="my-3 block select-none font-sans text-xs text-muted">
                <span className="rounded-full bg-surface-2 px-2.5 py-1">{t("pages.diff.unchanged", { count: s.words })}</span>
              </span>
            );
          }
          if (s.op === "eq") return <span key={i} className="text-fg/80">{s.text}</span>;
          // Mark each line's words, not the line breaks between them, so a new paragraph doesn't leave tinted stubs.
          const parts = s.text.split(/(\s*\n\s*)/).map((t, j) => /^\s*$/.test(t) ? t : s.op === "add"
            ? <span key={j} className="rounded-[3px] bg-accent-tint px-0.5 text-fg [box-decoration-break:clone]">{t}</span>
            : <span key={j} className="rounded-[3px] bg-danger-tint px-0.5 text-danger [box-decoration-break:clone] line-through decoration-danger/70">{t}</span>);
          return s.op === "add"
            ? <ins key={i} className="no-underline"><span className="sr-only">{t("pages.diff.added")}</span>{parts}<span className="sr-only">]</span></ins>
            : <del key={i} className="no-underline"><span className="sr-only">{t("pages.diff.removed")}</span>{parts}<span className="sr-only">]</span></del>;
        })}
      </div>
    </div>
  );
}
