"use client";
import { useEffect } from "react";
import Link from "next/link";
import { ChevronLeft, Printer } from "lucide-react";
import { Button } from "@/components/ui";
import type { ArtifactView } from "@/lib/artifacts";
import type { DesignSetView } from "@/lib/design-sets/tokens";
import { useT } from "@/lib/i18n/client";
import { ArtifactPreview } from "./artifact-preview";

/**
 * The document alone over the app, light theme, page-sized. On print everything but the document is hidden, so the
 * browser's "Save as PDF" gives a clean PDF (decks: one 16:9 slide per page).
 */
export function PrintView({ artifact: a, set, byline, autoPrint }: { artifact: ArtifactView; set: DesignSetView; byline: string; autoPrint?: boolean }) {
  const t = useT();
  useEffect(() => {
    if (!autoPrint) return;
    const h = setTimeout(() => window.print(), 600);
    return () => clearTimeout(h);
  }, [autoPrint]);
  return (
    <div id="mg-print-root" className="fixed inset-0 z-[70] overflow-auto" style={{ background: a.kind === "deck" ? set.tokens.colors.light.surface : set.tokens.colors.light.bg }}>
      <style>{`@media print{body *{visibility:hidden!important}#mg-print-root,#mg-print-root *{visibility:visible!important}
#mg-print-root{position:absolute!important;inset:0 auto auto 0!important;width:100%!important;overflow:visible!important;background:none!important}
#mg-print-root .mg-print-bar{display:none!important}html,body{background:#fff!important}}`}</style>
      <div className="mg-print-bar sticky top-0 z-10 flex flex-wrap items-center gap-3 bg-surface/95 px-4 py-2 shadow-[0_1px_0_var(--line)] backdrop-blur">
        <Link href={`/artifacts/${a.id}`} className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg"><ChevronLeft className="size-4" aria-hidden />{t("artifacts.print.back")}</Link>
        <span className="hidden text-sm text-muted sm:inline">{t("artifacts.print.lead")}</span>
        <Button className="ml-auto" onClick={() => window.print()}><Printer className="size-4" aria-hidden />{t("artifacts.print.go")}</Button>
      </div>
      <ArtifactPreview kind={a.kind} title={a.title} content={a.content} tokens={set.tokens} template={set.templates[a.kind]} status={a.status}
        byline={byline} theme="light" mode="print" scope={`p${a.id.slice(0, 8)}`} />
    </div>
  );
}
