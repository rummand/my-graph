"use client";

/** The Artifacts hub's "New" menu: one entry per kind that can be made today (src/lib/artifacts/kinds.ts). */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown, Plus } from "lucide-react";
import { buttonClass } from "@/components/ui";
import { useT } from "@/lib/i18n/client";
import type { MadeKindIcon } from "@/lib/artifacts/kinds";
import { madeIcon } from "./kind-icon";

export type NewMenuItem = { id: string; href: string; label: string; hint: string; icon: MadeKindIcon };

export function NewMenu({ items }: { items: NewMenuItem[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);

  if (!items.length) return null;
  const item = "flex w-full items-start gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-surface-2 focus:bg-surface-2 focus:outline-none";
  return (
    <div ref={box} className="relative">
      <button type="button" className={buttonClass("primary")} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Plus className="size-4" aria-hidden />{t("artifacts.hub.new")}<ChevronDown className="size-3.5 opacity-70" aria-hidden />
      </button>
      {open && (
        <div role="menu" aria-label={t("artifacts.hub.newMenu")} className="z-40 rounded-lg border border-line bg-surface p-1 shadow-lg max-sm:fixed max-sm:inset-x-4 max-sm:bottom-24 sm:absolute sm:right-0 sm:mt-1 sm:w-80">
          {items.map((i) => {
            const Icon = madeIcon(i.icon);
            return (
              <Link key={i.id} role="menuitem" href={i.href} className={item} onClick={() => setOpen(false)}>
                <Icon className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
                <span><span className="block font-medium text-fg">{i.label}</span><span className="block text-muted">{i.hint}</span></span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
