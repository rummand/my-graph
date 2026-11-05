"use client";
/**
 * Picking photos for a Google Photos connection. The server opens a picking session (no token reaches the browser);
 * Google's own picker opens in a new window; this polls the server until the person has picked, and the server then
 * starts the connection's run, which brings the photos into the library.
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui";
import { useT } from "@/lib/i18n/client";
import type { ConnectionDTO } from "@/lib/connectors";
import { api } from "./bits";

type Phase = "idle" | "opening" | "picking" | "picked" | "read" | "expired" | "timedOut" | "error";
type Session = { sessionId: string; pickerUri: string; pollMs: number; timeoutMs: number };

export function GooglePhotosPicks({ c }: { c: ConnectionDTO }) {
  const t = useT();
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [uri, setUri] = useState<string | null>(null);
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);
  const pending = Array.isArray((c.config as Record<string, unknown>).sessions) ? ((c.config as Record<string, unknown>).sessions as unknown[]).length : 0;

  function watch(s: Session) {
    stop.current?.();
    let live = true;
    const until = Date.now() + s.timeoutMs;
    let timer: ReturnType<typeof setTimeout> | null = null;
    stop.current = () => { live = false; if (timer) clearTimeout(timer); };
    const tick = async () => {
      if (!live) return;
      if (Date.now() > until) { setPhase("timedOut"); return; }
      try {
        const r = await api<{ state: "picking" | "picked" | "read" | "expired" }>(`/api/connections/oauth/${c.id}/photos?session=${encodeURIComponent(s.sessionId)}`);
        if (!live) return;
        if (r.state !== "picking") { setPhase(r.state); return; }
      } catch (e) {
        if (!live) return;
        setError(e instanceof Error ? e.message : t("connections.googlePhotos.failed"));
        setPhase("error");
        return;
      }
      timer = setTimeout(tick, s.pollMs);
    };
    timer = setTimeout(tick, s.pollMs);
  }

  async function pick() {
    // Open the window first, in the click, so the browser doesn't block it; point it at Google once the session exists.
    const win = window.open("about:blank", "_blank");
    if (win) win.opener = null;
    setPhase("opening"); setError(null); setUri(null);
    try {
      const s = await api<Session>(`/api/connections/oauth/${c.id}/photos`, { method: "POST" });
      // "/autoclose" closes Google's window by itself when the person presses Done.
      const target = `${s.pickerUri.replace(/\/+$/, "")}/autoclose`;
      setUri(target);
      if (win && !win.closed) win.location.href = target;
      else setError(t("connections.googlePhotos.popupBlocked"));
      setPhase("picking");
      watch(s);
    } catch (e) {
      win?.close();
      setError(e instanceof Error ? e.message : t("connections.googlePhotos.failed"));
      setPhase("error");
    }
  }

  const busy = phase === "opening" || phase === "picking";
  const message: Partial<Record<Phase, string>> = {
    picking: t("connections.googlePhotos.picking"),
    picked: t("connections.googlePhotos.bringing"),
    read: t("connections.googlePhotos.read"),
    expired: t("connections.googlePhotos.expired"),
    timedOut: t("connections.googlePhotos.timedOut"),
  };
  return (
    <div className="space-y-2">
      <p className="max-w-[65ch] text-sm text-muted">{t("connections.googlePhotos.lead")}</p>
      {pending > 0 && phase === "idle" && <p className="text-sm text-muted">{t("connections.googlePhotos.pending", { count: pending })}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={pick}>
          {phase === "picked" || phase === "read" ? t("connections.googlePhotos.pickMore") : t("connections.googlePhotos.pick")}
        </Button>
        {phase === "picking" && uri && (
          <a href={uri} target="_blank" rel="noopener noreferrer" className="text-sm text-accent hover:underline">{t("connections.googlePhotos.open")}</a>
        )}
      </div>
      {message[phase] && <p role="status" className="max-w-[65ch] text-sm">{message[phase]}</p>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  );
}
