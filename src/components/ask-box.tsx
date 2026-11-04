"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { clsx } from "clsx";
import { useT } from "@/lib/i18n/client";
import { askAssistant } from "./assistant/events";

/**
 * "Ask anything" in the shell: asks in the always-active session, in the Ask panel beside the page (on /chat, in the
 * chat itself). Press / anywhere to focus it; ⌘J / Ctrl+J opens the panel. On phones a tap opens the panel's sheet.
 */
export function AskBox({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  const t = useT();

  useEffect(() => {
    if (compact) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !t.closest("input, textarea, [contenteditable=true], select")) {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [compact]);

  function ask(question: string) {
    if (askAssistant(question)) return;
    router.push(question ? `/chat?q=${encodeURIComponent(question)}` : "/chat");
  }

  return (
    <form role="search" onSubmit={(e) => { e.preventDefault(); const s = q.trim(); setQ(""); ref.current?.blur(); ask(s); }}
      className="group relative">
      <Sparkles className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-accent" aria-hidden />
      <input ref={ref} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("shell.ask.label")} title={t("shell.ask.shortcut")}
        onFocus={compact ? (e) => { e.currentTarget.blur(); ask(""); } : undefined}
        placeholder={compact ? t("shell.ask.placeholderShort") : t("shell.ask.placeholder")}
        className={clsx("h-9 w-full rounded-md bg-surface pl-8 pr-12 text-sm ring-1 ring-inset ring-line placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent")} />
      {!compact && (
        <span className="pointer-events-none absolute right-2 top-1/2 flex -translate-y-1/2 gap-1 group-focus-within:hidden">
          <kbd className="rounded bg-surface-2 px-1.5 text-xs text-muted">⌘J</kbd>
        </span>
      )}
    </form>
  );
}
