"use client";
/**
 * Live highlights for the composer, in three tiers:
 *
 * 1. Instant, every keystroke, in this tab: the viewer's lexicon (GET /api/annotate/lexicon, revalidated by ETag,
 *    kept in memory and sessionStorage) runs through a trie matcher, plus deterministic detectors (dates, times,
 *    emails, phones, links, money) and a faint "maybe new" mark on capitalised names that aren't in the graph.
 * 2. Per sentence: a sentence is sent once it ends (. ! ? or a line break) or after 350 ms idle, alone, to
 *    POST /api/annotate/stream (NDJSON). Results are kept by the sentence's hash; only a sentence whose text changed
 *    is cancelled, never another sentence's work. While a sentence is edited its old result is relocated, not dropped.
 * 3. Facts across sentences: after a 1.5 s pause, with two or more sentences, and only when new things appeared,
 *    POST /api/annotate/facts (a newer pass replaces an older one; typing alone doesn't cancel it).
 *
 * mux down: tiers 2–3 pause for 30 s; tier 1 keeps working.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PickedMention } from "@/components/mention/use-mention-typeahead";
import { locateSpans } from "@/lib/mentions/markup";
import { detectDetails, maybeNewNames } from "@/lib/mentions/live/detect";
import { buildMatcher, type LexEntry, type Matcher } from "@/lib/mentions/live/matcher";
import { mergeLive, relocateResult, type FactsResult, type MergeOutput, type SentenceResult } from "@/lib/mentions/live/merge";
import { firstDiff, Lru, splitSentences, type Sentence } from "@/lib/mentions/live/sentences";

const IDLE_MS = 350;
/** A sentence that just got its full stop waits this long, in case the "." was "Dr." or "12." after all. */
const SETTLE_MS = 120;
const FACTS_PAUSE_MS = 1500;
const MAX_INFLIGHT = 4;
const MUX_BACKOFF_MS = 30_000;
const STORE_KEY = "mg.lexicon.v1";

type LexPayload = {
  version: string; graphId: string; readOnly: boolean; canGrowModel: boolean; selfLabel: string; etag: string;
  entries: { i: string; l: string; t: string; a?: string[]; k?: string; kl?: string; me?: 1; s?: 1 }[];
};
export type LexState = { etag: string; graphId: string; readOnly: boolean; canGrowModel: boolean; selfLabel: string; matcher: Matcher; size: number };

/* ── Lexicon (shared by every composer in the tab) ─────────────────────────────────────────────────────── */

let memo: { etag: string; payload: LexPayload; state: LexState } | null = null;
let loading: Promise<LexState | null> | null = null;
const listeners = new Set<(s: LexState | null) => void>();

function toState(p: LexPayload, etag: string): LexState {
  const entries: LexEntry[] = p.entries.map((e) => ({ id: e.i, label: e.l, type: e.t, aliases: e.a, kind: e.k ?? null, kindLabel: e.kl ?? null, self: !!e.me, sensitive: !!e.s }));
  const matcher = buildMatcher(entries);
  return { etag, graphId: p.graphId, readOnly: p.readOnly, canGrowModel: p.canGrowModel, selfLabel: p.selfLabel, matcher, size: entries.length };
}

function readStore(): { etag: string; payload: LexPayload } | null {
  try { const raw = sessionStorage.getItem(STORE_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function writeStore(etag: string, payload: LexPayload) {
  // Sensitive names stay in memory only.
  try {
    if (payload.entries.some((e) => e.s)) sessionStorage.removeItem(STORE_KEY);
    else sessionStorage.setItem(STORE_KEY, JSON.stringify({ etag, payload }));
  } catch { /* full or private */ }
}

/**
 * Revalidate the lexicon. A stored copy is only used after the server answers 304 for its ETag (which covers the
 * viewer and the graph), so names from another graph or person never show, not even for a moment.
 */
function refreshLexicon(): Promise<LexState | null> {
  if (loading) return loading;
  loading = (async () => {
    const prior = memo ?? readStore();
    try {
      const res = await fetch("/api/annotate/lexicon", { cache: "no-store", headers: prior ? { "if-none-match": prior.etag } : {} });
      if (res.status === 304 && prior) {
        memo = memo ?? { ...prior, state: toState(prior.payload, prior.etag) };
      } else if (res.ok) {
        const payload = (await res.json()) as LexPayload;
        const etag = res.headers.get("etag") ?? payload.etag;
        memo = { etag, payload, state: toState(payload, etag) };
        writeStore(etag, payload);
      } else if (res.status === 401 || res.status === 403) {
        memo = null;
      }
    } catch { /* offline: keep what we have */ }
    const s = memo?.state ?? null;
    for (const l of listeners) l(s);
    return s;
  })().finally(() => { loading = null; });
  return loading;
}

let lastCheck = 0;
function revalidateNow() { lastCheck = Date.now(); void refreshLexicon(); }
function useLexicon(enabled: boolean) {
  const [state, setState] = useState<LexState | null>(null);
  useEffect(() => {
    if (!enabled) return;
    listeners.add(setState);
    lastCheck = Date.now();
    void refreshLexicon();
    const onFocus = () => { if (Date.now() - lastCheck > 10_000) { lastCheck = Date.now(); void refreshLexicon(); } };
    window.addEventListener("focus", onFocus);
    return () => { listeners.delete(setState); window.removeEventListener("focus", onFocus); };
  }, [enabled]);
  /** Cheap (a 304 when nothing changed), so focusing the box always checks: a graph switch never leaves old names. */
  const revalidate = useCallback(() => revalidateNow(), []);
  return { lex: enabled ? state : null, revalidate };
}

/* ── The hook ──────────────────────────────────────────────────────────────────────────────────────────── */

const worth = (s: Sentence) => s.text.length >= 6 && /\p{L}{2}/u.test(s.text);

export type LiveHighlights = MergeOutput & {
  lex: LexState | null;
  /** Sentences being read by the model right now. */
  reading: number;
  muxDown: boolean;
  revalidate: () => void;
};

export function useLiveHighlights({ value, enabled, paused, sensitive, mentions, created }: {
  value: string; enabled: boolean; paused: boolean; sensitive: boolean; mentions: PickedMention[]; created: string[];
}): LiveHighlights {
  const { lex, revalidate } = useLexicon(enabled);
  const modelOn = enabled && !paused && !!lex && !lex.readOnly;

  // Tier 1: synchronous, every keystroke.
  const sentences = useMemo(() => splitSentences(value), [value]);
  const links = useMemo(() => (enabled && lex ? lex.matcher.match(value).filter((m) => !m.entry.self) : []), [enabled, lex, value]);
  const details = useMemo(() => (enabled && lex && !lex.readOnly ? detectDetails(value) : []), [enabled, lex, value]);
  // The name being typed at the very end gets its "maybe new" mark once the person moves on or pauses (no flicker
  // on "Bellahøj P…" before it becomes the known "Bellahøj Pool").
  const [settledOn, setSettledOn] = useState<string | null>(null);
  useEffect(() => {
    const t = window.setTimeout(() => setSettledOn(value), 600);
    return () => window.clearTimeout(t);
  }, [value]);
  const settled = settledOn === value;
  const maybe = useMemo(() => {
    if (!enabled || !lex || lex.readOnly) return [];
    const tail = value.trimEnd().length;
    return maybeNewNames(value, [...links, ...details]).filter((d) => settled || d.end < tail);
  }, [enabled, lex, value, links, details, settled]);

  // Tier 2: per sentence.
  const results = useRef(new Lru<string, SentenceResult>(400));
  const inflight = useRef(new Map<string, AbortController>());
  const queue = useRef<Sentence[]>([]);
  const [rev, setRev] = useState(0);
  const [reading, setReading] = useState(0);
  const [muxDownUntil, setMuxDownUntil] = useState(0);
  const prevValue = useRef(value);
  const sensitiveRef = useRef(sensitive);
  sensitiveRef.current = sensitive;
  const live = useRef(new Set<string>());

  const pump = useCallback(() => {
    while (inflight.current.size < MAX_INFLIGHT && queue.current.length) {
      const s = queue.current.shift()!;
      if (!live.current.has(s.key) || results.current.has(s.key) || inflight.current.has(s.key)) continue;
      const ac = new AbortController();
      inflight.current.set(s.key, ac);
      setReading(inflight.current.size);
      void (async () => {
        try {
          const res = await fetch("/api/annotate/stream", {
            method: "POST", signal: ac.signal, headers: { "content-type": "application/json" },
            body: JSON.stringify({ sentences: [{ key: s.key, text: s.text }], sensitive: sensitiveRef.current }),
          });
          if (!res.ok || !res.body) return;
          // The graph changed (or this tab switched graphs): fetch the names again.
          const lx = res.headers.get("x-lexicon");
          if (lx && memo && lx !== memo.etag) revalidateNow();
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = "";
          for (;;) {
            const { value: chunk, done } = await reader.read();
            if (done) break;
            buf += dec.decode(chunk, { stream: true });
            let nl: number;
            while ((nl = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, nl);
              buf = buf.slice(nl + 1);
              if (!line.trim()) continue;
              const ev = JSON.parse(line) as { t: string; key: string; result?: SentenceResult };
              if (ev.t === "model" && ev.result) {
                results.current.set(s.key, { ...ev.result, key: s.key, text: s.text });
                setMuxDownUntil(0);
                setRev((r) => r + 1);
              } else if (ev.t === "muxDown") {
                setMuxDownUntil(Date.now() + MUX_BACKOFF_MS);
              }
            }
          }
        } catch { /* cancelled because the sentence changed, or offline */ } finally {
          if (inflight.current.get(s.key) === ac) inflight.current.delete(s.key);
          setReading(inflight.current.size);
          pump();
        }
      })();
    }
  }, []);

  useEffect(() => {
    const editAt = firstDiff(prevValue.current, value);
    prevValue.current = value;
    live.current = new Set(sentences.map((s) => s.key));
    // Cancel only sentences whose text changed (their key is gone); other sentences keep going.
    for (const [k, ac] of inflight.current) if (!live.current.has(k)) { ac.abort(); inflight.current.delete(k); }
    queue.current = queue.current.filter((q) => live.current.has(q.key));
    if (!modelOn || Date.now() < muxDownUntil) return;
    const settle: Sentence[] = [], idle: Sentence[] = [];
    for (const s of sentences) {
      if (!worth(s) || results.current.has(s.key) || inflight.current.has(s.key) || queue.current.some((q) => q.key === s.key)) continue;
      const editing = editAt >= s.start && editAt <= s.end;
      if (!editing) { queue.current.push(s); continue; } // pasted, or untouched: read now
      if (s.complete && editAt >= s.end - 1) settle.push(s); // just finished
      else idle.push(s);
    }
    pump();
    const timers: number[] = [];
    if (settle.length) timers.push(window.setTimeout(() => { queue.current.push(...settle); pump(); }, SETTLE_MS));
    if (idle.length) timers.push(window.setTimeout(() => { queue.current.push(...idle); pump(); }, IDLE_MS));
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [value, sentences, modelOn, muxDownUntil, pump]);

  // When mux comes back after the pause, try again.
  useEffect(() => {
    if (!muxDownUntil) return;
    const t = window.setTimeout(() => setMuxDownUntil(0), Math.max(0, muxDownUntil - Date.now()));
    return () => window.clearTimeout(t);
  }, [muxDownUntil]);

  useEffect(() => () => { for (const ac of inflight.current.values()) ac.abort(); }, []);

  // Another graph: nothing read in the old one may stay on screen.
  const graphId = lex?.graphId ?? null;
  const seenGraph = useRef<string | null>(null);
  useEffect(() => {
    if (!graphId || seenGraph.current === graphId) return;
    const first = seenGraph.current === null;
    seenGraph.current = graphId;
    if (first) return;
    for (const ac of inflight.current.values()) ac.abort();
    inflight.current.clear();
    queue.current = [];
    results.current = new Lru(400);
    layout.current = [];
    setFacts(null);
    factsSent.current = new Set();
    setRev((r) => r + 1);
  }, [graphId]);

  // Each sentence's result, or the result of the sentence it grew out of (relocated) while it is being re-read.
  const layout = useRef<{ start: number; end: number; result: SentenceResult | null }[]>([]);
  const aligned = useMemo(() => {
    void rev;
    const used = new Set<number>();
    return sentences.map((s) => {
      const r = results.current.get(s.key);
      if (r) return r.text === s.text ? r : { ...r, text: s.text };
      let best = -1, bestOverlap = 0;
      layout.current.forEach((p, i) => {
        if (!p.result || used.has(i)) return;
        const o = Math.min(p.end, s.end) - Math.max(p.start, s.start);
        if (o > bestOverlap) { bestOverlap = o; best = i; }
      });
      if (best < 0) return null;
      used.add(best);
      return relocateResult(layout.current[best].result!, s.text);
    });
  }, [sentences, rev]);
  useEffect(() => { layout.current = sentences.map((s, i) => ({ start: s.start, end: s.end, result: aligned[i] })); }, [sentences, aligned]);

  // Tier 3: facts across sentences.
  const [facts, setFacts] = useState<FactsResult | null>(null);
  const factsSent = useRef<Set<string>>(new Set());
  const factsAbort = useRef<AbortController | null>(null);

  const located = useMemo(() => {
    if (!enabled || !mentions.length) return [];
    return locateSpans(value, mentions.map((m) => ({ ref: m.nodeId, surface: `@${m.label}` })))
      .map((s) => { const m = mentions.find((x) => x.nodeId === s.ref)!; return { start: s.start, end: s.end, nodeId: m.nodeId, label: m.label, type: m.type ?? "thing" }; });
  }, [enabled, mentions, value]);

  const merged = useMemo(() => mergeLive({
    text: value, sentences, results: aligned, links, mentions: located, created: enabled ? created : [],
    facts, details, maybe, linksOnly: !!lex?.readOnly,
  }), [value, sentences, aligned, links, located, created, enabled, facts, details, maybe, lex]);

  useEffect(() => {
    if (!modelOn || Date.now() < muxDownUntil) return;
    const ents = merged.plan.entities;
    // Facts inside one sentence come with that sentence; this pass is for facts across sentences, so it needs two
    // sentences, two things (or one new one), and something not seen by the last pass.
    const fresh = ents.some((e) => !factsSent.current.has(e.ref));
    if (sentences.length < 2 || !fresh || (ents.length < 2 && !ents.some((e) => !e.existing))) return;
    const t = window.setTimeout(async () => {
      factsAbort.current?.abort();
      const ac = new AbortController();
      factsAbort.current = ac;
      factsSent.current = new Set(ents.map((e) => e.ref));
      try {
        const res = await fetch("/api/annotate/facts", {
          method: "POST", signal: ac.signal, headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: value.slice(0, 4000), sensitive: sensitiveRef.current, entities: ents.slice(0, 40).map((e) => ({ ref: e.ref, label: e.label, type: e.type, nodeId: e.nodeId })) }),
        });
        if (res.ok) setFacts(await res.json());
        else if (res.status === 503) setMuxDownUntil(Date.now() + MUX_BACKOFF_MS);
      } catch { /* replaced by a newer pass */ }
    }, FACTS_PAUSE_MS);
    return () => window.clearTimeout(t);
  }, [value, sentences.length, merged.plan.entities, modelOn, muxDownUntil]);

  // After Send (the box empties): forget the facts pass and look for new names in the graph.
  useEffect(() => {
    if (value.trim()) return;
    setFacts(null);
    factsSent.current = new Set();
    if (!enabled) return;
    const t = window.setTimeout(() => revalidate(), 1500);
    return () => window.clearTimeout(t);
  }, [value, enabled, revalidate]);

  return { ...merged, lex, reading, muxDown: muxDownUntil > 0, revalidate };
}
