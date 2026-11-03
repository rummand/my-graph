import Link from "next/link";
import { FilePlus, MessageCircle, Sparkles, Upload } from "lucide-react";
import { hrefs } from "./section";

export const TOMORROW_QUESTION = "What do I need for tomorrow?";

const base = "inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const secondary = `${base} border border-line bg-surface hover:bg-surface-2`;

export function QuickActions() {
  return (
    <nav aria-label="Quick actions" className="flex flex-wrap gap-2">
      <Link href={hrefs.upload} className={secondary}><Upload aria-hidden className="size-4" />Upload</Link>
      <Link href={hrefs.chat} className={secondary}><MessageCircle aria-hidden className="size-4" />Ask</Link>
      <Link href={hrefs.newWiki} className={secondary}><FilePlus aria-hidden className="size-4" />New wiki page</Link>
      <Link href={hrefs.ask(TOMORROW_QUESTION)} className={`${base} bg-accent-tint text-accent hover:opacity-90`}>
        <Sparkles aria-hidden className="size-4" />{TOMORROW_QUESTION}
      </Link>
    </nav>
  );
}
