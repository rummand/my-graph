/**
 * What a library item is to the people who use it, and what a rebuild still has to do for it. Pure.
 */

export type DocKind = "mail" | "letter" | "scan" | "photo" | "recording" | "note" | "mailbox" | "file";

export const DOC_KINDS: DocKind[] = ["mail", "letter", "scan", "photo", "recording", "note", "mailbox", "file"];

/** Enough words read off an image that it is a document (a scanned letter), not a photo with a sign in it. */
const SCAN_MIN_CHARS = 160;

export function docKindOf(s: { mime: string | null; kind?: string | null; meta?: Record<string, unknown> | null; ocrChars?: number }): DocKind {
  const m = (s.mime ?? "").toLowerCase();
  const meta = s.meta ?? {};
  if (s.kind === "recording") return "recording";
  if (m === "message/rfc822" || s.kind === "email") return "mail";
  if (m === "application/mbox" || m === "application/zip") return "mailbox";
  if (m.startsWith("image/")) return meta.ocr === "done" && (s.ocrChars ?? 0) >= SCAN_MIN_CHARS ? "scan" : "photo";
  if (m === "application/pdf") {
    const warnings = Array.isArray(meta.warnings) ? (meta.warnings as unknown[]) : [];
    const scanned = (meta.scannedPages ?? null) as { read?: number } | null;
    return (scanned?.read ?? 0) > 0 || warnings.some((w) => typeof w === "string" && /scan/i.test(w)) ? "scan" : "letter";
  }
  if (m.includes("wordprocessingml")) return "letter";
  if (m.startsWith("audio/")) return "recording";
  if (m.startsWith("text/")) return "note";
  return "file";
}

/** How many characters of OCR text an image's textContent carries (after "Text in the image:"). */
export function ocrCharsOf(textContent: string | null | undefined): number {
  if (!textContent) return 0;
  const i = textContent.indexOf("Text in the image:");
  return i < 0 ? 0 : textContent.length - i - "Text in the image:".length;
}

/* ── Rebuild ─────────────────────────────────────────────────────────────────────────────────────────── */

export type RebuildSource = {
  mime: string | null;
  kind: string;
  status: string;
  documentDate: Date | string | null;
  threadKey: string | null;
  hasText: boolean;
  meta: Record<string, unknown>;
};

export type RebuildNeeds = { date: boolean; thread: boolean; kind: boolean; proposals: boolean };

/**
 * What re-reading a source would still add. A rebuild skips what is known:
 *  - date: no document date yet and no earlier attempt found none (meta.documentDateChecked);
 *  - thread: an email without a thread key;
 *  - kind: no meta.docKind yet;
 *  - proposals: there is text, nothing was proposed from it yet (meta.changeSetId / meta.proposedAt), and the
 *    old pipeline didn't already write its findings straight into the graph (meta.extracted from before change sets).
 * `muxUp` false: proposals need the model, so they wait for the next rebuild.
 */
export function rebuildNeeds(s: RebuildSource, muxUp: boolean): RebuildNeeds {
  const m = s.meta ?? {};
  const container = s.mime === "application/mbox" || s.mime === "application/zip";
  const readBefore = typeof m.extraction === "string" && m.extraction === "done" && !!m.extracted && !m.proposedAt;
  return {
    date: !container && !s.documentDate && !m.documentDateChecked,
    thread: (s.mime === "message/rfc822" || s.kind === "email") && !s.threadKey,
    kind: !m.docKind,
    proposals: muxUp && !container && s.status === "ready" && s.hasText && !m.changeSetId && !m.proposedAt && !readBefore,
  };
}

export const needsAnything = (n: RebuildNeeds) => n.date || n.thread || n.kind || n.proposals;
