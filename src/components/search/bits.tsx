/**
 * Pieces shared by the ⌘K palette and the /search page: the icon for a kind of hit and text with its matched
 * letters marked. No hooks, so server and client components can both render them.
 */
import { clsx } from "clsx";
import {
  BookMarked, Box, Building2, CalendarDays, FileAudio, FileImage, FileSpreadsheet, FileText, FolderKanban, GitPullRequestArrow, Globe,
  Hash, Mail, MapPin, MessageCircle, NotebookText, Presentation, Scale, ScrollText, type LucideIcon,
} from "lucide-react";
import { Avatar } from "@/components/ui";
import { splitByRanges } from "@/lib/search/highlight";
import type { Range } from "@/lib/search/types";

const KIND_ICON: Record<string, LucideIcon> = {
  place: MapPin, organization: Building2, event: CalendarDays, topic: Hash, project: FolderKanban, thing: Box,
  page: NotebookText, document: ScrollText, deck: Presentation, rule: Scale, definition: BookMarked, ruleset: Scale,
  chat: MessageCircle, change: GitPullRequestArrow,
};

export function fileIcon(mime: string | null | undefined): LucideIcon {
  const m = (mime ?? "").toLowerCase();
  if (m.startsWith("image/")) return FileImage;
  if (m.startsWith("audio/")) return FileAudio;
  if (m === "message/rfc822") return Mail;
  if (m === "text/html") return Globe;
  if (m.includes("spreadsheetml") || m === "text/csv") return FileSpreadsheet;
  if (m.includes("presentationml")) return Presentation;
  return FileText;
}

/** The leading visual of a row: a person's avatar in their colour, else the kind's icon on a quiet tile. */
export function HitIcon({ kind, sub, title, colorId, Icon, size = 28, className }: {
  kind: string; sub?: string | null; title: string; colorId?: string | null; Icon?: LucideIcon; size?: number; className?: string;
}) {
  if (kind === "person" && colorId) return <Avatar id={colorId} name={title} size={size} />;
  const I = Icon ?? (kind === "file" ? fileIcon(sub) : KIND_ICON[kind] ?? FileText);
  return (
    <span aria-hidden className={clsx("inline-flex shrink-0 items-center justify-center rounded-md bg-surface-2 text-muted", className)} style={{ width: size, height: size }}>
      <I className="size-4" strokeWidth={1.75} />
    </span>
  );
}

/** Text with the matched parts in ink and semibold (no colour: matches are structure, not data). */
export function Marked({ text, ranges, className, hitClassName = "font-semibold text-fg" }: { text: string; ranges: Range[]; className?: string; hitClassName?: string }) {
  if (!ranges.length) return <span className={className}>{text}</span>;
  return (
    <span className={className}>
      {splitByRanges(text, ranges).map((p, i) => (p.hit ? <b key={i} className={hitClassName}>{p.text}</b> : <span key={i}>{p.text}</span>))}
    </span>
  );
}
