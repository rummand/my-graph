"use client";
import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { clsx } from "clsx";
import { useT } from "@/lib/i18n/client";

/** A value to copy (an address, a command, a key), in code type, with its copy button. */
export function CopyValue({ value, label, className, secret }: { value: string; label?: string; className?: string; secret?: boolean }) {
  const t = useT();
  const [done, setDone] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setDone(true);
      setTimeout(() => setDone(false), 1800);
    } catch { /* the person can still select it */ }
  }
  return (
    <div className={clsx("flex min-w-0 items-stretch gap-2", className)}>
      <code aria-label={label} className={clsx("min-w-0 flex-1 select-all overflow-x-auto whitespace-nowrap rounded-md bg-surface-2 px-3 py-2 font-mono text-[13px] [scrollbar-width:thin]", secret && "text-accent")}>
        {value}
      </code>
      <button type="button" onClick={copy}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent">
        {done ? <Check size={15} aria-hidden className="text-accent" /> : <Copy size={15} aria-hidden />}
        <span>{done ? t("mcpServer.keys.copied") : t("mcpServer.keys.copy")}</span>
      </button>
    </div>
  );
}
