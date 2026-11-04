"use client";

/** The document's "Download" menu: PowerPoint, PDF (through the print page) and a self-contained HTML file. */
import { useEffect, useRef, useState } from "react";
import { ChevronDown, Download, FileCode2, Presentation, Printer } from "lucide-react";
import { buttonClass } from "@/components/ui";
import { useT } from "@/lib/i18n/client";

export function ExportMenu({ id, kind }: { id: string; kind: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);

  useEffect(() => {
    if (!busy) return;
    const done = setTimeout(() => setBusy(false), 4000);
    return () => clearTimeout(done);
  }, [busy]);

  const item = "flex w-full items-start gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-surface-2 focus:bg-surface-2 focus:outline-none";
  return (
    <div ref={box} className="relative">
      <button type="button" className={buttonClass("secondary")} aria-label={t("artifacts.export.download")} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Download className="size-4" aria-hidden />
        <span className="hidden sm:inline">{busy ? t("artifacts.export.preparing") : t("artifacts.export.download")}</span>
        <ChevronDown className="size-3.5 text-muted" aria-hidden />
      </button>
      {open && (
        <div role="menu" className="z-40 rounded-lg border border-line bg-surface p-1 shadow-lg max-sm:fixed max-sm:inset-x-4 max-sm:bottom-24 sm:absolute sm:right-0 sm:mt-1 sm:w-72">
          <a role="menuitem" href={`/api/artifacts/${id}/export?format=pptx`} className={item} onClick={() => { setBusy(true); setOpen(false); }}>
            <Presentation className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
            <span><span className="block font-medium text-fg">{t("artifacts.export.pptx")}</span><span className="block text-muted">{t(kind === "deck" ? "artifacts.export.pptxDeckHint" : "artifacts.export.pptxHint")}</span></span>
          </a>
          <a role="menuitem" href={`/api/artifacts/${id}/export?format=pptx&fonts=standard`} className={item} onClick={() => { setBusy(true); setOpen(false); }}>
            <Presentation className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
            <span><span className="block font-medium text-fg">{t("artifacts.export.pptxStandard")}</span><span className="block text-muted">{t("artifacts.export.pptxStandardHint")}</span></span>
          </a>
          <a role="menuitem" href={`/artifacts/${id}/print`} className={item} onClick={() => setOpen(false)}>
            <Printer className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
            <span><span className="block font-medium text-fg">{t("artifacts.export.pdf")}</span><span className="block text-muted">{t("artifacts.export.pdfHint")}</span></span>
          </a>
          <a role="menuitem" href={`/api/artifacts/${id}/export?format=html`} className={item} onClick={() => setOpen(false)}>
            <FileCode2 className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
            <span><span className="block font-medium text-fg">{t("artifacts.export.html")}</span><span className="block text-muted">{t("artifacts.export.htmlHint")}</span></span>
          </a>
        </div>
      )}
    </div>
  );
}
