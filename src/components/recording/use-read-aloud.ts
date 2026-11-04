"use client";
/**
 * Read text aloud, sentence by sentence, with the word being said: My Graph's voice (mux text to speech, one request
 * per sentence, the next one fetched while this one plays) and, when that voice isn't available, the device's own
 * (speechSynthesis, which reports each word as it starts). With mux the word follows sentence-level timing: each
 * sentence's real length, spread over its words.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { wordInSentence, wordsOf } from "./timeline-math";

export type ReadState = { item: number; word: number } | null;

type Options = { language: "en" | "da"; sourceId?: string; rate?: number };

export function useReadAloud(items: string[], opts: Options) {
  const [state, setState] = useState<ReadState>(null);
  const [voice, setVoice] = useState<"mux" | "browser" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useRef(0);
  const audio = useRef<HTMLAudioElement | null>(null);
  const urls = useRef(new Map<number, Promise<string | null>>());
  const useBrowser = useRef(false);
  const rate = useRef(opts.rate ?? 1);
  useEffect(() => {
    rate.current = opts.rate ?? 1;
    if (audio.current) audio.current.playbackRate = rate.current;
  }, [opts.rate]);

  const cleanup = useCallback(() => {
    run.current++;
    audio.current?.pause();
    audio.current = null;
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
    for (const p of urls.current.values()) void p.then((u) => u && URL.revokeObjectURL(u));
    urls.current.clear();
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const fetchItem = useCallback((i: number): Promise<string | null> => {
    if (i >= items.length) return Promise.resolve(null);
    let p = urls.current.get(i);
    if (!p) {
      p = fetch("/api/recordings/speak", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: items[i].slice(0, 1200), language: opts.language, ...(opts.sourceId ? { sourceId: opts.sourceId } : {}) }),
      }).then(async (r) => (r.ok && (r.headers.get("content-type") ?? "").startsWith("audio/") ? URL.createObjectURL(await r.blob()) : null)).catch(() => null);
      urls.current.set(i, p);
    }
    return p;
  }, [items, opts.language, opts.sourceId]);

  const playBrowser = useCallback((i: number, token: number) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) { setError("unsupported"); setState(null); return; }
    if (token !== run.current) return;
    if (i >= items.length) { setState(null); return; }
    const words = wordsOf(items[i]);
    const u = new SpeechSynthesisUtterance(items[i]);
    u.lang = opts.language === "da" ? "da-DK" : "en-GB";
    u.rate = rate.current;
    setState({ item: i, word: 0 });
    u.onboundary = (e) => {
      if (token !== run.current || e.name === "sentence") return;
      const w = words.findIndex((x) => e.charIndex >= x.start && e.charIndex < x.end + 1);
      if (w >= 0) setState({ item: i, word: w });
    };
    u.onend = () => { if (token === run.current) playBrowser(i + 1, token); };
    u.onerror = () => { if (token === run.current) setState(null); };
    window.speechSynthesis.speak(u);
  }, [items, opts.language]);

  const playMux = useCallback(async (i: number, token: number) => {
    if (token !== run.current) return;
    if (i >= items.length) { setState(null); return; }
    setState({ item: i, word: 0 });
    const url = await fetchItem(i);
    if (token !== run.current) return;
    if (!url) {
      // The voice isn't available: the device reads from here on.
      useBrowser.current = true;
      setVoice("browser");
      playBrowser(i, token);
      return;
    }
    void fetchItem(i + 1);
    const a = new Audio(url);
    a.playbackRate = rate.current;
    audio.current = a;
    const words = wordsOf(items[i]);
    let raf = 0;
    const tick = () => {
      if (token !== run.current || a.paused) return;
      setState({ item: i, word: wordInSentence(words, a.currentTime, a.duration) });
      raf = requestAnimationFrame(tick);
    };
    a.onplay = () => { raf = requestAnimationFrame(tick); };
    a.onended = () => {
      cancelAnimationFrame(raf);
      URL.revokeObjectURL(url);
      urls.current.delete(i);
      if (token === run.current) void playMux(i + 1, token);
    };
    a.onerror = () => { cancelAnimationFrame(raf); if (token === run.current) { useBrowser.current = true; setVoice("browser"); playBrowser(i, token); } };
    await a.play().catch(() => { if (token === run.current) { useBrowser.current = true; setVoice("browser"); playBrowser(i, token); } });
  }, [items, fetchItem, playBrowser]);

  const start = useCallback((from = 0) => {
    cleanup();
    setError(null);
    const token = run.current;
    if (useBrowser.current) { setVoice("browser"); playBrowser(from, token); return; }
    setVoice("mux");
    void playMux(from, token);
  }, [cleanup, playBrowser, playMux]);

  const stop = useCallback(() => {
    cleanup();
    setState(null);
  }, [cleanup]);

  return { state, voice, error, start, stop, reading: state !== null };
}
