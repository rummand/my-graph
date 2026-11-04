import { clsx } from "clsx";
import { AlertTriangle, Clock, FileAudio, FileQuestion, FileSpreadsheet, FileText, FileType, Image as ImageIcon, Inbox, LoaderCircle, Mail, Presentation, StickyNote } from "lucide-react";
import type { FileCategory } from "@/lib/ingest/mime";
import type { Lx } from "./i18n";

export type Visibility = "private" | "parents" | "household";
export type SourceStatus = "pending" | "processing" | "ready" | "failed";

/** Icon for a file category; CSV gets a spreadsheet icon. */
export function TypeIcon({ category, mime, className }: { category: FileCategory; mime?: string | null; className?: string }) {
  const cls = clsx("shrink-0", className);
  if (mime === "text/csv") return <FileSpreadsheet aria-hidden className={cls} />;
  switch (category) {
    case "pdf": return <FileType aria-hidden className={cls} />;
    case "document": return <FileText aria-hidden className={cls} />;
    case "slides": return <Presentation aria-hidden className={cls} />;
    case "spreadsheet": return <FileSpreadsheet aria-hidden className={cls} />;
    case "text": return <StickyNote aria-hidden className={cls} />;
    case "image": return <ImageIcon aria-hidden className={cls} />;
    case "audio": return <FileAudio aria-hidden className={cls} />;
    case "email": return <Mail aria-hidden className={cls} />;
    case "mailbox": return <Inbox aria-hidden className={cls} />;
    default: return <FileQuestion aria-hidden className={cls} />;
  }
}

/** Its job in the reading queue, when one waits or runs (see SourceSummary.job). */
export type ItemJob = { status: "queued" | "running"; error: string | null; attempts: number; progress?: { step: string; done?: number; total?: number; label?: string } | null } | null | undefined;

/**
 * Waiting or half-read with no job in the reading queue: it stopped (an old restart) and needs resuming.
 * A file whose job waits or runs is never stalled; a brand-new one gets a minute for its job to appear.
 */
export function isStuck(status: SourceStatus, startedAt: string | null, createdAt: string, job?: ItemJob): boolean {
  if (status !== "processing" && status !== "pending") return false;
  if (job) return false;
  const t = Date.parse(startedAt ?? createdAt);
  return Number.isFinite(t) && Date.now() - t > 60_000;
}

/** The one status mark a file carries. Ready files carry none: being read is the normal state. */
export function StatusPill({ L, status, stuck = false, showReady = false, job, className }: { L: Pick<Lx, "t">; status: SourceStatus; stuck?: boolean; showReady?: boolean; job?: ItemJob; className?: string }) {
  const { t } = L;
  const base = clsx("inline-flex flex-none items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium", className);
  if (job?.status === "running") return <span className={clsx(base, "bg-accent-tint text-accent")}><LoaderCircle aria-hidden className="size-3.5 motion-safe:animate-spin" />{t("library.status.reading")}</span>;
  if (job?.status === "queued") {
    return job.error
      ? <span className={clsx(base, "bg-warn-tint text-warn")} title={job.error}><Clock aria-hidden className="size-3.5" />{t("library.status.retrying")}</span>
      : <span className={clsx(base, "bg-surface-2 text-muted")}><Clock aria-hidden className="size-3.5" />{t("library.status.queued")}</span>;
  }
  if (stuck) return <span className={clsx(base, "bg-warn-tint text-warn")}><AlertTriangle aria-hidden className="size-3.5" />{t("library.status.stalled")}</span>;
  switch (status) {
    case "pending":
      return <span className={clsx(base, "bg-surface-2 text-muted")}><Clock aria-hidden className="size-3.5" />{t("library.status.queued")}</span>;
    case "processing":
      return <span className={clsx(base, "bg-accent-tint text-accent")}><LoaderCircle aria-hidden className="size-3.5 motion-safe:animate-spin" />{t("library.status.reading")}</span>;
    case "ready":
      return showReady ? <span className={clsx(base, "bg-surface-2 text-muted")}>{t("library.status.ready")}</span> : null;
    case "failed":
      return <span className={clsx(base, "bg-danger-tint text-danger")}><AlertTriangle aria-hidden className="size-3.5" />{t("library.status.failed")}</span>;
  }
}

/** File extension as people know it, e.g. ".pdf". */
export function extensionLabel(title: string): string | null {
  const m = /\.([a-z0-9]{1,5})$/i.exec(title);
  return m ? `.${m[1].toLowerCase()}` : null;
}


export { stepText, extractionNote, formatBytes, formatDay, formatDocDate, formatMoment, kindWord, visibilityLabel, visibilityOptions, listJoin, countsLine, type Lx } from "./i18n";
