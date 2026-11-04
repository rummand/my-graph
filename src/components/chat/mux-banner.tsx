"use client";
import { Fragment, useState, type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui";
import { useT } from "@/lib/i18n/client";
import { useIsFamily } from "./graph-kind";

export type MuxStatus = { ok: boolean; reachable: boolean; configured: boolean };

/** Explains, in plain words, why the assistant can't write answers right now and how to fix it. */
export function MuxBanner({ initial, canFix }: { initial: MuxStatus; canFix: boolean }) {
  const t = useT();
  const family = useIsFamily();
  const [status, setStatus] = useState(initial);
  const [checking, setChecking] = useState(false);
  if (status.ok) return null;

  async function recheck() {
    setChecking(true);
    try {
      const res = await fetch("/api/chat/status?fresh=1", { cache: "no-store" });
      if (res.ok) setStatus(await res.json());
    } finally {
      setChecking(false);
    }
  }

  const title = !status.configured ? t("chat.mux.notConnected") : t("chat.mux.unreachable");
  return (
    <div role="status" className="mb-8 rounded-lg bg-warn-tint/70 p-4 text-sm">
      <div className="flex items-start gap-3">
        <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{title}</p>
          <p className="mt-1 text-fg/80">{t("chat.mux.stillAsk")}</p>
          {canFix && (
            !status.configured ? (
              <p className="mt-2 text-fg/70">
                <Filled text={t("chat.mux.fixKey")} slots={{ prefix: <Code>mux-sk-</Code>, key: <Code pill>MUX_API_KEY</Code>, url: <Code pill>MUX_BASE_URL</Code>, default: <Code>http://127.0.0.1:7070</Code> }} />
              </p>
            ) : (
              <p className="mt-2 text-fg/70">
                <Filled text={t("chat.mux.fixRunning")} slots={{ url: <Code pill>MUX_BASE_URL</Code> }} />
              </p>
            )
          )}
          {!canFix && <p className="mt-2 text-fg/70">{family ? t("chat.mux.askParent") : t("chat.mux.askOwner")}</p>}
        </div>
        <Button type="button" variant="secondary" size="sm" onClick={recheck} disabled={checking} aria-label={t("chat.mux.recheck")}>
          <RefreshCw aria-hidden className={`h-4 w-4 ${checking ? "animate-spin" : ""}`} />
          <span className="hidden sm:inline">{checking ? t("chat.mux.checking") : t("chat.mux.checkAgain")}</span>
        </Button>
      </div>
    </div>
  );
}

function Code({ children, pill }: { children: ReactNode; pill?: boolean }) {
  return <code className={pill ? "rounded bg-surface/70 px-1 font-mono text-xs" : "font-mono text-xs"}>{children}</code>;
}

/** A translated sentence with `{slot}` placeholders filled by elements (code names stay untranslated). */
function Filled({ text, slots }: { text: string; slots: Record<string, ReactNode> }) {
  return <>{text.split(/(\{\w+\})/).map((part, i) => {
    const m = part.match(/^\{(\w+)\}$/);
    return <Fragment key={i}>{m && m[1] in slots ? slots[m[1]] : part}</Fragment>;
  })}</>;
}
