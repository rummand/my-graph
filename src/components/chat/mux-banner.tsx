"use client";
import { useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui";

export type MuxStatus = { ok: boolean; reachable: boolean; configured: boolean };

/** Explains, in plain words, why the assistant can't write answers right now and how to fix it. */
export function MuxBanner({ initial, canFix }: { initial: MuxStatus; canFix: boolean }) {
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

  const title = !status.configured ? "The assistant isn't connected to mux yet" : "The assistant can't reach mux right now";
  return (
    <div role="status" className="mb-8 rounded-lg bg-warn-tint/70 p-4 text-sm">
      <div className="flex items-start gap-3">
        <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{title}</p>
          <p className="mt-1 text-fg/80">
            You can still ask: you&apos;ll get the matching things from your graph with their sources, just no written answer.
          </p>
          {canFix && (
            !status.configured ? (
              <p className="mt-2 text-fg/70">
                To fix it, create a key for My Graph in mux (it starts with <code className="font-mono text-xs">mux-sk-</code>), set{" "}
                <code className="rounded bg-surface/70 px-1 font-mono text-xs">MUX_API_KEY</code> in the server&apos;s environment
                (and <code className="rounded bg-surface/70 px-1 font-mono text-xs">MUX_BASE_URL</code> if mux isn&apos;t on
                {" "}<code className="font-mono text-xs">http://127.0.0.1:7070</code>), then restart the app.
              </p>
            ) : (
              <p className="mt-2 text-fg/70">
                Check that mux is running and that <code className="rounded bg-surface/70 px-1 font-mono text-xs">MUX_BASE_URL</code> points at it.
              </p>
            )
          )}
          {!canFix && <p className="mt-2 text-fg/70">A parent can set this up under Family &amp; settings.</p>}
        </div>
        <Button type="button" variant="secondary" size="sm" onClick={recheck} disabled={checking} aria-label="Check the connection again">
          <RefreshCw aria-hidden className={`h-4 w-4 ${checking ? "animate-spin" : ""}`} />
          <span className="hidden sm:inline">{checking ? "Checking…" : "Check again"}</span>
        </Button>
      </div>
    </div>
  );
}
