"use client";
/**
 * The recording player, "a finger on the transcript": the waveform (who speaks where, what has played), play/pause,
 * ±15 s, speed, and the transcript with the word being said marked as it plays. Without Record's sound it says so
 * and offers to read the transcript aloud, with the same marker following the voice. A link with #t=… or ?t=…
 * (seconds) or a citation's time= (ms) opens it at that moment.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { clsx } from "clsx";
import { ExternalLink, FastForward, Info, Pause, Play, Rewind, Volume2, VolumeX } from "lucide-react";
import { Kbd } from "@/components/ui";
import { useLocale, useT } from "@/lib/i18n/client";
import type { RecordingView } from "@/lib/connectors/record/recordings";
import { Waveform } from "./waveform";
import { Transcript } from "./transcript";
import { Speakers } from "./speakers";
import { SummaryBlock } from "./summary";
import { useReadAloud } from "./use-read-aloud";
import { clock, nextSpeed, skip, SPEEDS, startFromUrl, wordAt } from "./timeline-math";

const SPEED_KEY = "mg.recording.speed";

export type PlayerRecording = RecordingView;

export function RecordingPlayer({ recording: r, layout = "page" }: { recording: PlayerRecording; layout?: "page" | "embedded" }) {
  const t = useT();
  const locale = useLocale();
  const audio = useRef<HTMLAudioElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [ms, setMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [peaks, setPeaks] = useState<number[] | null>(r.peaks);
  const [audioState, setAudioState] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const [audioError, setAudioError] = useState<string | null>(null);
  const [duration, setDuration] = useState(r.durationMs);
  const [noSound, setNoSound] = useState(false);
  const hasAudio = r.audio === "available" && audioState !== "failed" && !noSound;

  const speakerKey = useMemo(() => {
    const m = new Map(r.speakers.map((s) => [s.name, s.personId ?? `speaker:${s.name}`]));
    return (name: string) => m.get(name) ?? `speaker:${name}`;
  }, [r.speakers]);

  // Reading the transcript aloud when there is no sound: one item per line.
  const lineTexts = useMemo(() => r.lines.map((l) => l.text), [r.lines]);
  const reader = useReadAloud(lineTexts, { language: locale === "da" ? "da" : "en", sourceId: r.id, rate: speed });
  const readWord = reader.state ? (r.lines[reader.state.item]?.first ?? 0) + reader.state.word : -1;

  useEffect(() => {
    try {
      const s = Number(localStorage.getItem(SPEED_KEY));
      if ((SPEEDS as readonly number[]).includes(s)) setSpeed(s);
    } catch { /* no storage */ }
  }, []);
  useEffect(() => {
    if (audio.current) audio.current.playbackRate = speed;
    try { localStorage.setItem(SPEED_KEY, String(speed)); } catch { /* no storage */ }
  }, [speed]);

  // The waveform: fetched with the sound's address the first time (the server keeps it).
  useEffect(() => {
    if (peaks || r.audio !== "available") return;
    let gone = false;
    fetch(`/api/recordings/${r.id}/peaks`).then(async (res) => {
      // Record has no sound for this meeting: say so and offer reading aloud instead.
      if (res.status === 404 && !gone) setNoSound(true);
      return res.ok ? res.json() : null;
    }).then((d: { peaks?: number[] | null; durationMs?: number } | null) => {
      if (gone || !d?.peaks?.length) return;
      setPeaks(d.peaks);
      if (d.durationMs) setDuration((x) => x || d.durationMs!);
    }).catch(() => {});
    return () => { gone = true; };
  }, [peaks, r.audio, r.id]);

  // Smooth time while playing (timeupdate is only ~4 a second).
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => { if (audio.current) setMs(audio.current.currentTime * 1000); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const seek = useCallback((to: number) => {
    const v = Math.max(0, Math.min(to, duration || to));
    setMs(v);
    if (audio.current && hasAudio) {
      if (audioState === "idle") setAudioState("loading");
      audio.current.currentTime = v / 1000;
    } else if (reader.reading) {
      const li = Math.max(0, r.lines.findLastIndex((l) => l.a <= v));
      reader.start(li);
    }
  }, [duration, hasAudio, audioState, reader, r.lines]);

  const toggle = useCallback(() => {
    if (hasAudio && audio.current) {
      if (audio.current.paused) {
        if (audioState === "idle") setAudioState("loading");
        void audio.current.play().catch(() => {});
      } else audio.current.pause();
      return;
    }
    if (reader.reading) reader.stop();
    else reader.start(Math.max(0, r.lines.findLastIndex((l) => l.a <= ms)));
  }, [hasAudio, audioState, reader, r.lines, ms]);

  // Open at the moment a link asks for (#t=83, ?t=1:23, time=83000).
  useEffect(() => {
    const at = startFromUrl(window.location.search, window.location.hash);
    if (at !== null) {
      setMs(at);
      if (audio.current) audio.current.currentTime = at / 1000;
    }
  }, []);

  // Keyboard: space/K, ←/→ or J/L, [ and ], / to search. Not while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || el?.closest("input, textarea, select, [contenteditable=true], [role=slider]")) return;
      if (layout === "embedded" && !el?.closest("[data-recording-player]") && el !== document.body) return;
      const k = e.key;
      if (k === " " || k === "k" || k === "K") { if (el?.tagName === "BUTTON" && k === " ") return; e.preventDefault(); toggle(); }
      else if (k === "ArrowLeft" || k === "j" || k === "J") { e.preventDefault(); seek(skip(ms, -15_000, duration)); }
      else if (k === "ArrowRight" || k === "l" || k === "L") { e.preventDefault(); seek(skip(ms, 15_000, duration)); }
      else if (k === "[") setSpeed((s) => nextSpeed(s, -1));
      else if (k === "]") setSpeed((s) => nextSpeed(s, 1));
      else if (k === "/") { e.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, seek, ms, duration, layout]);

  const audioFailed = async () => {
    setPlaying(false);
    const res = await fetch(`/api/recordings/${r.id}/audio`, { headers: { range: "bytes=0-1" } }).catch(() => null);
    const body = res && !res.ok ? ((await res.json().catch(() => ({}))) as { error?: string }) : null;
    setAudioError(body?.error ?? t("recordings.errors.generic"));
    setAudioState("failed");
  };

  const playedMs = reader.reading && readWord >= 0 ? r.words[readWord]?.a ?? ms : ms;
  const current = reader.reading ? readWord : hasAudio && (playing || ms > 0) ? wordAt(r.words, ms) : -1;
  const isPlaying = hasAudio ? playing : reader.reading;

  const notice = r.audio === "no_connection" ? t("recordings.player.noConnection")
    : r.audio === "not_offered" ? t("recordings.player.noAudioYet")
    : noSound || r.audio === "none" ? t("recordings.player.noAudio")
    : audioState === "failed" ? t("recordings.player.audioFailed", { reason: audioError ?? "" }) : null;

  return (
    <section data-recording-player aria-label={t("recordings.player.aria")} className="space-y-6">
      <div className="rounded-lg bg-surface p-4 sm:p-5">
        <Waveform peaks={peaks} lines={r.lines} durationMs={duration} currentMs={playedMs} colorKey={speakerKey} onSeek={seek} label={t("recordings.player.waveform")} />
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex items-center gap-1">
            <button type="button" onClick={() => seek(skip(ms, -15_000, duration))} aria-label={t("recordings.player.back15")} title={t("recordings.player.back15")}
              className="inline-flex size-9 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-fg"><Rewind className="size-4" /></button>
            <button type="button" onClick={toggle} aria-label={isPlaying ? t("recordings.player.pause") : hasAudio ? t("recordings.player.play") : t("recordings.readAloud.start")}
              className="inline-flex size-11 items-center justify-center rounded-full bg-fg text-bg hover:opacity-90">
              {isPlaying ? <Pause className="size-5" /> : hasAudio ? <Play className="ml-0.5 size-5" /> : <Volume2 className="size-5" />}
            </button>
            <button type="button" onClick={() => seek(skip(ms, 15_000, duration))} aria-label={t("recordings.player.forward15")} title={t("recordings.player.forward15")}
              className="inline-flex size-9 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-fg"><FastForward className="size-4" /></button>
          </div>
          <span className="text-sm tabular-nums text-muted" aria-live="off">{t("recordings.player.at", { now: clock(playedMs), total: clock(duration) })}</span>
          {audioState === "loading" && !playing && <span className="text-sm text-muted">{t("recordings.player.loading")}</span>}
          {!hasAudio && reader.reading && <span className="text-sm text-accent">{t("recordings.readAloud.reading")}</span>}
          <div className="ml-auto flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-sm text-muted">
              <span className="sr-only sm:not-sr-only">{t("recordings.player.speed")}</span>
              <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}
                className="h-8 rounded-md border border-line bg-surface px-2 text-sm text-fg tabular-nums">
                {SPEEDS.map((s) => <option key={s} value={s}>{t("recordings.player.speedValue", { speed: String(s).replace(".", locale === "da" ? "," : ".") })}</option>)}
              </select>
            </label>
            {r.link && (
              <a href={r.link} target="_blank" rel="noreferrer noopener" className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-muted hover:bg-surface-2 hover:text-fg">
                <ExternalLink aria-hidden className="size-4" /><span className="hidden sm:inline">{t("recordings.openInRecord")}</span>
              </a>
            )}
          </div>
        </div>
        {notice && (
          <p className="mt-3 flex items-start gap-2 text-sm text-muted">
            {r.audio === "available" && !noSound ? <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" /> : <VolumeX aria-hidden className="mt-0.5 size-4 shrink-0" />}<span>{notice}</span>
          </p>
        )}
        {reader.voice === "browser" && reader.reading && <p className="mt-2 text-xs text-muted">{t("recordings.readAloud.browserVoice")}</p>}
        {r.timing === "estimated" && r.words.length > 0 && <p className="mt-2 text-xs text-muted">{t("recordings.player.estimated")}</p>}
        {r.audio === "available" && !noSound && (
          // The sound comes through My Graph (access checked each time); Record's address never reaches the browser.
          <audio ref={audio} preload="none" src={`/api/recordings/${r.id}/audio`}
            onPlay={() => setPlaying(true)} onPause={() => { setPlaying(false); if (audio.current) setMs(audio.current.currentTime * 1000); }}
            onEnded={() => setPlaying(false)} onCanPlay={() => setAudioState("ready")} onError={() => void audioFailed()}
            onLoadedMetadata={(e) => { const d = e.currentTarget.duration; if (Number.isFinite(d) && d > 0) setDuration(Math.round(d * 1000)); e.currentTarget.playbackRate = speed; }}
            onSeeked={(e) => setMs(e.currentTarget.currentTime * 1000)} />
        )}
      </div>

      <div className={clsx("grid gap-x-10 gap-y-8", layout === "page" && "lg:grid-cols-[minmax(0,1fr)_300px]")}>
        <div className="min-w-0">
          <h2 className="mb-3 text-lg font-semibold">{t("recordings.transcript.title")}</h2>
          <Transcript words={r.words} lines={r.lines} current={current} playing={isPlaying} colorKey={speakerKey} onJump={seek} searchRef={searchRef} />
          <details className="mt-4 text-sm text-muted">
            <summary className="cursor-pointer select-none">{t("recordings.player.shortcuts")}</summary>
            <p className="mt-1">{t("recordings.player.shortcutsList")} <Kbd>Space</Kbd> <Kbd>←</Kbd> <Kbd>→</Kbd> <Kbd>[</Kbd> <Kbd>]</Kbd> <Kbd>/</Kbd></p>
          </details>
        </div>
        <aside className="min-w-0 space-y-8">
          <Speakers recordingId={r.id} speakers={r.speakers} colorKey={speakerKey} />
          {layout === "page" && <SummaryBlock id={r.id} summary={r.summary} decisions={r.decisions} todos={r.todos} />}
          {layout === "page" && r.changeSetId && (
            <p className="text-sm text-muted">{t("recordings.proposals.waiting")} <Link className="text-accent hover:underline" href={`/changes/${r.changeSetId}`}>{t("recordings.proposals.review")}</Link></p>
          )}
        </aside>
      </div>
    </section>
  );
}
