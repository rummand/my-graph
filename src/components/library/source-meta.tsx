import { clsx } from "clsx";
import { AlertTriangle, CheckCircle2, FileAudio, FileQuestion, FileSpreadsheet, FileText, FileType, Image as ImageIcon, LoaderCircle, Mail, StickyNote } from "lucide-react";
import type { FileCategory } from "@/lib/ingest/mime";

export type Visibility = "private" | "parents" | "household";
export type SourceStatus = "pending" | "processing" | "ready" | "failed";

export const VISIBILITY_OPTIONS: { value: Visibility; label: string; hint: string }[] = [
  { value: "private", label: "Only me", hint: "Nobody else in the family can see it." },
  { value: "parents", label: "Parents", hint: "You and the parents in the family." },
  { value: "household", label: "Whole family", hint: "Everyone in the family, children included." },
];

export const visibilityLabel = (v: Visibility) => VISIBILITY_OPTIONS.find((o) => o.value === v)?.label ?? v;

/** Icon for a file category; CSV gets a spreadsheet icon. */
export function TypeIcon({ category, mime, className }: { category: FileCategory; mime?: string | null; className?: string }) {
  const cls = clsx("shrink-0", className);
  if (mime === "text/csv") return <FileSpreadsheet aria-hidden className={cls} />;
  switch (category) {
    case "pdf": return <FileType aria-hidden className={cls} />;
    case "document": return <FileText aria-hidden className={cls} />;
    case "text": return <StickyNote aria-hidden className={cls} />;
    case "image": return <ImageIcon aria-hidden className={cls} />;
    case "audio": return <FileAudio aria-hidden className={cls} />;
    case "email": return <Mail aria-hidden className={cls} />;
    default: return <FileQuestion aria-hidden className={cls} />;
  }
}

/** A processing job that hasn't finished in 20 minutes is probably lost (e.g. the server restarted). */
export function isStuck(status: SourceStatus, startedAt: string | null, createdAt: string): boolean {
  if (status !== "processing" && status !== "pending") return false;
  const t = Date.parse(startedAt ?? createdAt);
  return Number.isFinite(t) && Date.now() - t > 20 * 60_000;
}

export function StatusPill({ status, stuck = false }: { status: SourceStatus; stuck?: boolean }) {
  const base = "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium";
  if (stuck) return <span className={clsx(base, "bg-surface-2 text-warn")}><AlertTriangle aria-hidden className="size-3.5" />Stalled</span>;
  switch (status) {
    case "pending":
      return <span className={clsx(base, "bg-surface-2 text-muted")}><LoaderCircle aria-hidden className="size-3.5 motion-safe:animate-spin" />Queued</span>;
    case "processing":
      return <span className={clsx(base, "bg-accent-tint text-accent")} role="status"><LoaderCircle aria-hidden className="size-3.5 motion-safe:animate-spin" />Reading…</span>;
    case "ready":
      return <span className={clsx(base, "bg-accent-tint text-accent")}><CheckCircle2 aria-hidden className="size-3.5" />Ready</span>;
    case "failed":
      return <span className={clsx(base, "bg-surface-2 text-danger")}><AlertTriangle aria-hidden className="size-3.5" />Failed</span>;
  }
}

export function formatBytes(n: number | null | undefined): string {
  if (!n && n !== 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Plain-English version of meta.extraction. */
export function extractionNote(extraction: string | null): string | null {
  if (!extraction || extraction === "done") return null;
  if (extraction.startsWith("skipped: mux unreachable")) return "Saved and searchable by keyword. People, places and events weren't picked out because the model gateway was unreachable — use Retry later.";
  if (extraction.startsWith("skipped: no text")) return "No readable text was found, so nothing was added to the graph.";
  if (extraction.startsWith("failed")) return `Finding people, places and events failed: ${extraction.replace(/^failed:\s*/, "")}`;
  if (extraction.startsWith("partial")) return `Only part of the file was read for facts: ${extraction.replace(/^partial:\s*/, "")}`;
  return extraction;
}
