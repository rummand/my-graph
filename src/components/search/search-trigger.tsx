"use client";
import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { openSearch } from "./events";

/** ⌘K on a Mac, Ctrl K elsewhere (decided after hydration, so the server render never guesses). */
function useShortcutLabel(): string {
  const [label, setLabel] = useState("⌘K");
  useEffect(() => {
    const mac = /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
    if (!mac) setLabel("Ctrl K");
  }, []);
  return label;
}

/** The "Search" field at the top of the rail: looks like a field, opens the palette. */
export function SearchField() {
  const t = useT();
  const kbd = useShortcutLabel();
  return (
    <button type="button" onClick={() => openSearch()} title={t("search.shortcut")} aria-label={t("search.fieldLabel")} aria-keyshortcuts="Meta+K Control+K /"
      className="group flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-sm text-muted ring-1 ring-inset ring-line transition-colors hover:bg-surface hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
      <Search className="size-4 shrink-0" aria-hidden />
      <span className="flex-1 truncate">{t("search.field")}</span>
      <kbd className="rounded bg-surface-2 px-1.5 font-sans text-xs text-muted">{kbd}</kbd>
    </button>
  );
}

/** The magnifier in the phone header. */
export function SearchButton() {
  const t = useT();
  return (
    <button type="button" onClick={() => openSearch()} aria-label={t("search.open")}
      className="inline-flex size-9 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent">
      <Search className="size-[18px]" aria-hidden />
    </button>
  );
}
