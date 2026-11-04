"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { clsx } from "clsx";
import { AnimatePresence, motion } from "motion/react";
import { Loader2, Mic, Square } from "lucide-react";
import { useLocale, useT } from "@/lib/i18n/client";
import { joinDictation, otherLang, speechLang } from "@/lib/assistant/transcribe";

type Lang = "da" | "en";
type State = "idle" | "listening" | "transcribing";
type ErrKey = "blocked" | "noMic" | "noSpeech" | "network" | "unsupported" | "failed" | "tooLong";

const LANG_KEY = "mg.dictation.lang";
const SILENCE_MS = 2200;
const NOTHING_MS = 8000;
const MAX_RECORD_MS = 180_000;

/* Minimal typings for the Web Speech API (not in TypeScript's DOM lib everywhere). */
type SRAlt = { transcript: string };
type SRResult = { isFinal: boolean; length: number; [i: number]: SRAlt };
type SREvent = { resultIndex: number; results: { length: number; [i: number]: SRResult } };
type SR = {
  lang: string; continuous: boolean; interimResults: boolean; maxAlternatives: number;
  onresult: ((e: SREvent) => void) | null; onerror: ((e: { error: string }) => void) | null; onend: (() => void) | null;
  start(): void; stop(): void; abort(): void;
};
type SRCtor = new () => SR;

function recognizer(): SRCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: SRCtor; webkitSpeechRecognition?: SRCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}
const canRecord = () => typeof window !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";
/** iPhone/iPad Safari repeats results in continuous mode; one utterance at a time works reliably there. */
const isIOS = () => typeof navigator !== "undefined" && (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

function readLang(fallback: Lang): Lang {
  try { const v = window.localStorage.getItem(LANG_KEY); return v === "da" || v === "en" ? v : fallback; } catch { return fallback; }
}

/**
 * The mic in the composer. Uses the browser's own speech recognition (Safari on iPhone and Mac, Chrome, Edge) in
 * Danish or English, with what you say appearing live in the box; a pause or a tap stops it. Where the browser can't
 * recognise speech, it records and sends the audio to /api/transcribe (Whisper through mux) instead.
 */
export function Dictation({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const t = useT();
  const locale = useLocale();
  const [lang, setLang] = useState<Lang>(locale === "da" ? "da" : "en");
  const [state, setState] = useState<State>("idle");
  const [error, setError] = useState<string | null>(null);
  const [supported, setSupported] = useState(true);
  const valueRef = useRef(value);
  valueRef.current = value;
  const stopRef = useRef<(() => void) | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    setLang(readLang(locale === "da" ? "da" : "en"));
    setSupported(!!recognizer() || canRecord());
  }, [locale]);
  useEffect(() => () => cleanupRef.current?.(), []);
  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(null), 7000);
    return () => window.clearTimeout(timer);
  }, [error]);

  const fail = useCallback((k: ErrKey | string) => {
    setError(k.includes(" ") ? k : t(`chat.dictation.errors.${k}`));
    setState("idle");
  }, [t]);

  const switchLang = () => {
    const next = otherLang(lang);
    setLang(next);
    try { window.localStorage.setItem(LANG_KEY, next); } catch { /* private window */ }
  };

  /** The browser recognises the speech itself: interim words show in the box as they're heard. */
  function listen(Ctor: SRCtor) {
    const r = new Ctor();
    const base = valueRef.current;
    let finals = "";
    let latest = "";
    let heard = false;
    let timer: number | undefined;
    const arm = (ms: number) => { window.clearTimeout(timer); timer = window.setTimeout(() => { try { r.stop(); } catch { /* ended */ } }, ms); };
    r.lang = speechLang(lang);
    r.interimResults = true;
    r.continuous = !isIOS();
    r.maxAlternatives = 1;
    r.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finals += res[0].transcript; else interim += res[0].transcript;
      }
      latest = `${finals}${interim}`;
      heard = heard || !!latest.trim();
      onChange(joinDictation(base, latest));
      arm(SILENCE_MS);
    };
    r.onerror = (e) => {
      const map: Record<string, ErrKey> = { "not-allowed": "blocked", "service-not-allowed": "blocked", "audio-capture": "noMic", "no-speech": "noSpeech", network: "network" };
      if (e.error === "aborted") return;
      fail(map[e.error] ?? "failed");
      heard = true; // the error says what happened; don't also say "didn't hear anything"
    };
    r.onend = () => {
      window.clearTimeout(timer);
      stopRef.current = null;
      cleanupRef.current = null;
      if (latest.trim()) onChange(joinDictation(base, latest));
      else if (!heard) setError(t("chat.dictation.errors.noSpeech"));
      setState("idle");
    };
    stopRef.current = () => { try { r.stop(); } catch { /* ended */ } };
    cleanupRef.current = () => { window.clearTimeout(timer); try { r.abort(); } catch { /* ended */ } };
    try {
      r.start();
      setState("listening");
      arm(NOTHING_MS);
    } catch {
      fail("failed");
    }
  }

  /** Fallback: record, stop after a pause (or a tap), send to Whisper, insert the text. */
  async function record() {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      const name = (e as { name?: string }).name;
      fail(name === "NotAllowedError" || name === "SecurityError" ? "blocked" : name === "NotFoundError" ? "noMic" : "failed");
      return;
    }
    const base = valueRef.current;
    const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"].find((m) => MediaRecorder.isTypeSupported?.(m)) ?? "";
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    const started = Date.now();
    let heardAt = 0;
    let loudAt = 0;
    let raf = 0;
    let ctx: AudioContext | null = null;
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AC) {
        ctx = new AC();
        const an = ctx.createAnalyser();
        an.fftSize = 1024;
        ctx.createMediaStreamSource(stream).connect(an);
        const buf = new Float32Array(an.fftSize);
        const tick = () => {
          an.getFloatTimeDomainData(buf);
          let sum = 0;
          for (const x of buf) sum += x * x;
          const rms = Math.sqrt(sum / buf.length);
          const now = Date.now();
          if (rms > 0.02) { loudAt = now; heardAt = heardAt || now; }
          const quiet = heardAt ? now - loudAt > SILENCE_MS : now - started > NOTHING_MS;
          if ((quiet || now - started > MAX_RECORD_MS) && rec.state === "recording") { rec.stop(); return; }
          raf = window.requestAnimationFrame(tick);
        };
        raf = window.requestAnimationFrame(tick);
      }
    } catch { /* no level meter: stop by tapping */ }
    const release = () => { window.cancelAnimationFrame(raf); stream.getTracks().forEach((tr) => tr.stop()); void ctx?.close().catch(() => {}); };
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      release();
      stopRef.current = null;
      cleanupRef.current = null;
      const blob = new Blob(chunks, { type: rec.mimeType || mime || "audio/webm" });
      if (blob.size < 800) { fail("noSpeech"); return; }
      setState("transcribing");
      try {
        const form = new FormData();
        form.append("audio", blob, "dictation");
        form.append("language", lang);
        const res = await fetch("/api/transcribe", { method: "POST", body: form });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) { fail(res.status === 413 ? "tooLong" : typeof body.error === "string" ? body.error : "failed"); return; }
        const text = String(body.text ?? "").trim();
        if (!text) { fail("noSpeech"); return; }
        onChange(joinDictation(base, text));
        setState("idle");
      } catch {
        fail("network");
      }
    };
    stopRef.current = () => { if (rec.state === "recording") rec.stop(); };
    cleanupRef.current = () => { rec.onstop = null; if (rec.state === "recording") rec.stop(); release(); };
    rec.start();
    setState("listening");
  }

  function toggle() {
    setError(null);
    if (state === "listening") { stopRef.current?.(); return; }
    if (state !== "idle") return;
    const Ctor = recognizer();
    if (Ctor) listen(Ctor);
    else if (canRecord()) void record();
    else fail("unsupported");
  }

  const other = otherLang(lang);
  const langName = (l: Lang) => t(l === "da" ? "chat.dictation.danish" : "chat.dictation.english");
  const status = state === "listening" ? t("chat.dictation.listening") : state === "transcribing" ? t("chat.dictation.transcribing") : error;

  if (!supported) return null;
  return (
    <span className="relative flex items-center">
      <AnimatePresence>
        {status && (
          <motion.span key={status} role={error && state === "idle" ? "alert" : "status"}
            initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }}
            className={clsx("absolute bottom-full right-0 mb-2 w-max max-w-[min(18rem,70vw)] rounded-md px-2.5 py-1.5 text-xs shadow-float",
              error && state === "idle" ? "bg-danger-tint text-danger" : "bg-fg text-bg")}>
            {status}
          </motion.span>
        )}
      </AnimatePresence>
      <button type="button" onClick={switchLang} disabled={state !== "idle"}
        title={t("chat.dictation.switchTo", { lang: langName(lang), other: langName(other) })}
        aria-label={t("chat.dictation.switchTo", { lang: langName(lang), other: langName(other) })}
        className="inline-flex h-8 min-w-8 items-center justify-center rounded-md px-1.5 text-[11px] font-semibold tracking-wide text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-50">
        {lang.toUpperCase()}
      </button>
      <button type="button" onClick={toggle} disabled={disabled || state === "transcribing"} aria-pressed={state === "listening"}
        aria-label={state === "listening" ? t("chat.dictation.stop") : t("chat.dictation.start")}
        title={state === "listening" ? t("chat.dictation.stop") : t("chat.dictation.start")}
        className={clsx("relative inline-flex size-8 items-center justify-center rounded-md transition-[background-color,color,transform] active:scale-[0.94] disabled:opacity-60",
          state === "listening" ? "bg-danger text-white" : "text-muted hover:bg-surface-2 hover:text-fg")}>
        {state === "listening" && <span aria-hidden className="absolute inset-0 animate-ping rounded-md bg-danger/40 motion-reduce:animate-none" />}
        {state === "transcribing" ? <Loader2 aria-hidden className="size-4 animate-spin" />
          : state === "listening" ? <Square aria-hidden className="relative size-3 fill-current" />
          : <Mic aria-hidden className="size-4" />}
      </button>
    </span>
  );
}
