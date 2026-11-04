"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { clsx } from "clsx";
import { useT } from "@/lib/i18n/client";

/** "Ask anything" in the shell: sends the question to the assistant. Press / anywhere to focus it. */
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

  return (
    <form role="search" onSubmit={(e) => { e.preventDefault(); const s = q.trim(); if (!s) return; setQ(""); router.push(`/chat?q=${encodeURIComponent(s)}`); }}
      className="group relative">
      <Sparkles className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-accent" aria-hidden />
      <input ref={ref} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("shell.ask.label")}
        placeholder={compact ? t("shell.ask.placeholderShort") : t("shell.ask.placeholder")}
        className={clsx("h-9 w-full rounded-md bg-surface pl-8 pr-8 text-sm ring-1 ring-inset ring-line placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent")} />
      {!compact && <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded bg-surface-2 px-1.5 text-xs text-muted group-focus-within:hidden">/</kbd>}
    </form>
  );
}
