import { clsx } from "clsx";
import { format, isSameYear, isToday, isYesterday } from "date-fns";
import { AlertTriangle, FileAudio, FileQuestion, FileSpreadsheet, FileText, FileType, Image as ImageIcon, LoaderCircle, Mail, StickyNote } from "lucide-react";
import type { FileCategory } from "@/lib/ingest/mime";

export type Visibility = "private" | "parents" | "household";
export type SourceStatus = "pending" | "processing" | "ready" | "failed";

export const VISIBILITY_OPTIONS: { value: Visibility; label: string; hint: string }[] = [
  { value: "private", label: "Only me", hint: "Nobody else in the family can see it." },
  { value: "parents", label: "Parents", hint: "You and the other parents in the family." },
  { value: "household", label: "Whole family", hint: "Everyone in the family, children included." },
];

export const visibilityLabel = (v: Visibility) => VISIBILITY_OPTIONS.find((o) => o.value === v)?.label ?? v;

/** What people call each kind of file, singular and as a filter label. */
export const KIND_WORD: Record<FileCategory, string> = {
  pdf: "PDF", document: "Word document", text: "Text file", image: "Photo", audio: "Recording", email: "Email", other: "File",
};

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

/** The one status mark a file carries. Ready files carry none: being read is the normal state. */
export function StatusPill({ status, stuck = false, showReady = false, className }: { status: SourceStatus; stuck?: boolean; showReady?: boolean; className?: string }) {
  const base = clsx("inline-flex flex-none items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium", className);
  if (stuck) return <span className={clsx(base, "bg-warn-tint text-warn")}><AlertTriangle aria-hidden className="size-3.5" />Stalled</span>;
  switch (status) {
    case "pending":
      return <span className={clsx(base, "bg-surface-2 text-muted")}><LoaderCircle aria-hidden className="size-3.5 motion-safe:animate-spin" />Waiting to be read</span>;
    case "processing":
      return <span className={clsx(base, "bg-accent-tint text-accent")}><LoaderCircle aria-hidden className="size-3.5 motion-safe:animate-spin" />Reading</span>;
    case "ready":
      return showReady ? <span className={clsx(base, "bg-surface-2 text-muted")}>Read</span> : null;
    case "failed":
      return <span className={clsx(base, "bg-danger-tint text-danger")}><AlertTriangle aria-hidden className="size-3.5" />Couldn&apos;t read</span>;
  }
}

export function formatBytes(n: number | null | undefined): string {
  if (!n && n !== 0) return "";
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** "Today", "Yesterday", "Tue 3 Nov", or "3 Nov 2025" for another year. */
export function formatDay(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (isToday(d)) return "Today";
  if (isYesterday(d)) return "Yesterday";
  return isSameYear(d, now) ? format(d, "EEE d MMM") : format(d, "d MMM yyyy");
}

/** "Tue 3 Nov at 20:57" (with the year when it isn't this year). */
export function formatMoment(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${isSameYear(d, now) ? format(d, "EEE d MMM") : format(d, "d MMM yyyy")} at ${format(d, "HH:mm")}`;
}

/** File extension as people know it, e.g. ".pdf". */
export function extensionLabel(title: string): string | null {
  const m = /\.([a-z0-9]{1,5})$/i.exec(title);
  return m ? `.${m[1].toLowerCase()}` : null;
}

/** Plain-English version of meta.extraction. */
export function extractionNote(extraction: string | null): string | null {
  if (!extraction || extraction === "done") return null;
  if (extraction.startsWith("skipped: mux unreachable")) return "The file is saved and searchable by its words, but nobody was picked out of it: the assistant was unreachable when it was read. Read it again once the assistant is back.";
  if (extraction.startsWith("skipped: no text")) return "No readable text was found, so nothing was added to the family's graph.";
  if (extraction.startsWith("failed")) return `Finding people, places and dates failed: ${extraction.replace(/^failed:\s*/, "")}`;
  if (extraction.startsWith("partial")) return `Only part of the file was read for people and dates: ${extraction.replace(/^partial:\s*/, "")}`;
  return extraction;
}
