import { FileText, Image, Newspaper, Presentation, ScrollText, UserRound, Workflow, type LucideIcon } from "lucide-react";
import type { MadeKindIcon } from "@/lib/artifacts/kinds";

const ICONS: Record<MadeKindIcon, LucideIcon> = { FileText, ScrollText, Presentation, Image, Workflow };

/** The registry's icon for a made kind (src/lib/artifacts/kinds.ts). */
export function madeIcon(name: MadeKindIcon): LucideIcon {
  return ICONS[name] ?? FileText;
}

/** The finer icon for one document (a report, a one-pager …). */
export const DOCUMENT_ICON: Record<string, LucideIcon> = { report: FileText, one_pager: Newspaper, deck: Presentation, brief: ScrollText, profile: UserRound };
