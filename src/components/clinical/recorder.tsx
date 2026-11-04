"use client";
/**
 * Record a session in the browser (MediaRecorder), upload a recording, or dictate the note. Audio goes to My Graph
 * only, is kept as a sensitive source and transcribed on the practice's own models. What the consent doesn't allow
 * is not offered; the server checks again.
 */
import { useEffect, useRef, useState } from "react";
import { Mic, Pause, Play, Square, Upload } from "lucide-react";
import { clsx } from "clsx";
import { Button } from "@/components/ui";
import { useT } from "@/lib/i18n/client";
import { call } from "./api";
import { fmtTime } from "./item-card";

type Mode = "record" | "dictate";

function pickMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]) if (MediaRecorder.isTypeSupported?.(m)) return m;
  return "";
}

export function Recorder({ sessionId, canRecord, canDictate, onSent }: { sessionId: string; canRecord: boolean; canDictate: boolean; onSent: () => void }) {
  const t = useT();
  const [mode, setMode] = useState<Mode | null>(null);
  const [paused, setPaused] = useState(false);
  const [secs, setSecs] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const stream = useRef<MediaStream | null>(null);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!mode || paused) return;
    const id = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [mode, paused]);
  useEffect(() => () => stream.current?.getTracks().forEach((tr) => tr.stop()), []);

  async function send(blob: Blob, m: "record" | "upload" | "dictate", name: string) {
    setBusy(true); setError(null);
    const form = new FormData();
    form.append("file", blob, name);
    form.append("mode", m);
    const r = await call(`/api/clinical/sessions/${sessionId}/audio`, { form }, t("clinical.err.offline"));
    setBusy(false);
    if (r.error) setError(r.error); else onSent();
  }

  async function start(m: Mode) {
    setError(null);
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) { setError(t("clinical.session.noRecorder")); return; }
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      setError(t("clinical.session.micDenied"));
      return;
    }
    const mime = pickMime();
    const r = new MediaRecorder(stream.current, mime ? { mimeType: mime } : undefined);
    chunks.current = [];
    r.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
    r.onstop = () => {
      stream.current?.getTracks().forEach((tr) => tr.stop());
      const type = r.mimeType || mime || "audio/webm";
      const blob = new Blob(chunks.current, { type });
      void send(blob, m, `${m}.${type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm"}`);
    };
    r.start(1000);
    rec.current = r;
    setSecs(0); setPaused(false); setMode(m);
  }

  function stop() {
    rec.current?.stop();
    rec.current = null;
    setMode(null);
  }

  if (mode) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-lg bg-surface p-3" role="status">
        <span className={clsx("size-2.5 rounded-full", paused ? "bg-muted" : "bg-danger")} aria-hidden />
        <span className="font-medium tabular-nums">{t(mode === "record" ? "clinical.session.recording" : "clinical.session.dictating", { time: fmtTime(secs) })}</span>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => { if (paused) { rec.current?.resume(); setPaused(false); } else { rec.current?.pause(); setPaused(true); } }}>
          {paused ? <Play aria-hidden className="size-4" /> : <Pause aria-hidden className="size-4" />}{paused ? t("clinical.session.resume") : t("clinical.session.pause")}
        </Button>
        <Button size="sm" onClick={stop}><Square aria-hidden className="size-4" />{t("clinical.session.stop")}</Button>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {canRecord && <Button disabled={busy} onClick={() => start("record")}><Mic aria-hidden className="size-4" />{t("clinical.session.record")}</Button>}
        {canRecord && (
          <>
            <input ref={file} type="file" accept="audio/*,video/webm,video/mp4,.m4a,.mp3,.wav,.webm,.ogg" className="sr-only" tabIndex={-1}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void send(f, "upload", f.name); e.target.value = ""; }} />
            <Button variant="secondary" disabled={busy} onClick={() => file.current?.click()}><Upload aria-hidden className="size-4" />{t("clinical.session.upload")}</Button>
          </>
        )}
        {canDictate && <Button variant="secondary" disabled={busy} onClick={() => start("dictate")} title={t("clinical.session.dictateHint")}><Mic aria-hidden className="size-4" />{t("clinical.session.dictate")}</Button>}
      </div>
      {busy && <p role="status" className="text-sm text-muted">{t("clinical.session.saving")}</p>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  );
}
