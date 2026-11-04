import Link from "next/link";
import { FilePlus, Sparkles, Upload } from "lucide-react";
import { buttonClass } from "@/components/ui";
import { getT } from "@/lib/i18n";
import { hrefs } from "./section";

/** The page's few direct actions. Asking anything else lives in the shell's ask box. `question` is already translated. */
export async function QuickActions({ question }: { question: string }) {
  const t = await getT();
  return (
    <nav aria-label={t("today.quick.label")} className="flex flex-wrap items-center gap-1.5">
      <Link href={hrefs.upload} className={buttonClass("ghost")}><Upload aria-hidden className="size-4" />{t("today.quick.upload")}</Link>
      <Link href={hrefs.newWiki} className={buttonClass("ghost")}><FilePlus aria-hidden className="size-4" />{t("today.quick.newWiki")}</Link>
      <Link href={hrefs.ask(question)} className={buttonClass("secondary")}>
        <Sparkles aria-hidden className="size-4 text-accent" />{question}
      </Link>
    </nav>
  );
}
