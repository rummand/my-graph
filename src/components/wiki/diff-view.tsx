import { clsx } from "clsx";
import { collapseUnchanged, diffStats, wordDiff } from "@/lib/wiki/diff";

/** Readable word diff: removed words struck through in red, added words highlighted, long unchanged stretches folded. */
export function DiffView({ before, after, beforeTitle, afterTitle }: { before: string; after: string; beforeTitle?: string; afterTitle?: string }) {
  const segs = wordDiff(before, after);
  const stats = diffStats(segs);
  const shown = collapseUnchanged(segs, 15);
  const titleChanged = beforeTitle !== undefined && afterTitle !== undefined && beforeTitle !== afterTitle;
  return (
    <div>
      <p className="mb-3 text-sm text-muted">
        {stats.added === 0 && stats.removed === 0 && !titleChanged ? "No text changes in this version." : (
          <>
            <span className="text-accent">{stats.added} word{stats.added === 1 ? "" : "s"} added</span>
            <span aria-hidden> · </span>
            <span className="text-danger">{stats.removed} removed</span>
            {titleChanged && <> · Title changed from “{beforeTitle}” to “{afterTitle}”</>}
          </>
        )}
      </p>
      <div className="max-w-[70ch] whitespace-pre-wrap break-words rounded-lg border border-line bg-surface p-4 leading-7">
        {shown.length === 0 && <span className="text-muted">This version is empty.</span>}
        {shown.map((s, i) => {
          if (s.op === "gap") return <span key={i} className="my-1 block select-none text-center text-xs text-muted">··· {s.words} unchanged word{s.words === 1 ? "" : "s"} ···</span>;
          if (s.op === "eq") return <span key={i}>{s.text}</span>;
          return s.op === "add"
            ? <ins key={i} className="rounded-sm bg-accent-tint text-accent no-underline"><span className="sr-only">[added: </span>{s.text}<span className="sr-only">]</span></ins>
            : <del key={i} className={clsx("rounded-sm text-danger line-through decoration-2")} style={{ background: "color-mix(in srgb, var(--danger) 12%, transparent)" }}><span className="sr-only">[removed: </span>{s.text}<span className="sr-only">]</span></del>;
        })}
      </div>
    </div>
  );
}
