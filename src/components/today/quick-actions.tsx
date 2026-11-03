import Link from "next/link";
import { FilePlus, Sparkles, Upload } from "lucide-react";
import { buttonClass } from "@/components/ui";
import { hrefs } from "./section";

export const TOMORROW_QUESTION = "What do I need for tomorrow?";

/** The page's few direct actions. Asking anything else lives in the shell's ask box. */
export function QuickActions() {
  return (
    <nav aria-label="Quick actions" className="flex flex-wrap items-center gap-1.5">
      <Link href={hrefs.upload} className={buttonClass("ghost")}><Upload aria-hidden className="size-4" />Upload</Link>
      <Link href={hrefs.newWiki} className={buttonClass("ghost")}><FilePlus aria-hidden className="size-4" />New wiki page</Link>
      <Link href={hrefs.ask(TOMORROW_QUESTION)} className={buttonClass("secondary")}>
        <Sparkles aria-hidden className="size-4 text-accent" />{TOMORROW_QUESTION}
      </Link>
    </nav>
  );
}
