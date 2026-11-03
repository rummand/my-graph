/**
 * mux contract (owned by the mux/assistant workstream). Server-only.
 * mux is the household's model gateway (OpenAI + Anthropic compatible, see MUX_BASE_URL). Every model call in My
 * Graph goes through here — never call a provider directly.
 * Routes: auto · fast · agent · smart · code · multilingual · vision · embed. `sensitive: true` must keep the request
 * on local models (route to a local model and send `x-mux-no-fallback: 1`).
 *
 * Errors: MuxUnavailableError (unreachable, timed out, no model), MuxAuthError (no key / key refused), MuxError (the
 * rest, e.g. 400/429). `embed` returns null instead of throwing when mux is down or not configured.
 */
import { errorFromResponse, MuxAuthError, MuxError, MuxUnavailableError } from "./errors";
import { buildHeaders, effectiveRoute, extractJson, messageText, muxConfig, readMuxHeaders } from "./request";
import { readSse } from "./sse";

export { MuxError, MuxAuthError, MuxUnavailableError, isMuxDown } from "./errors";

export type MuxRoute = "auto" | "fast" | "agent" | "smart" | "vision" | "multilingual" | "code";

export type MuxMessage = { role: "system" | "user" | "assistant"; content: string | MuxContentPart[] };
export type MuxContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

/** `graphId` is sent as an `x-mux-tags` entry (`graph:<id>`) so mux usage can be told apart per graph. */
export type MuxCallMeta = { userId: string; agent: string; traceId?: string; sensitive?: boolean; graphId?: string };

export type MuxResult = { text: string; model: string | null; route: string | null; requestId: string | null };

/* ── Transport ───────────────────────────────────────────────────────────────────────────────────────── */

const TIMEOUT = { complete: 120_000, connect: 45_000, idle: 90_000, embed: 30_000, transcribe: 600_000, health: 2_500 };

function requireKey(): ReturnType<typeof muxConfig> {
  const cfg = muxConfig();
  if (!cfg.apiKey) throw new MuxAuthError("mux is not configured: set MUX_API_KEY (a mux-sk-… key for My Graph's tenant).", 401, "not_configured");
  return cfg;
}

function anySignal(signals: (AbortSignal | undefined)[]): AbortSignal {
  const list = signals.filter((s): s is AbortSignal => !!s);
  return list.length === 1 ? list[0] : AbortSignal.any(list);
}

/** POST to mux; maps network failures and error statuses to typed errors. */
async function post(path: string, init: { body: BodyInit; headers: Record<string, string>; signal: AbortSignal }): Promise<Response> {
  const { baseUrl } = muxConfig();
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, { method: "POST", body: init.body, headers: init.headers, signal: init.signal, cache: "no-store" });
  } catch (e) {
    const err = e as Error;
    if (err?.name === "TimeoutError") throw new MuxUnavailableError("The model gateway (mux) took too long to answer.", 0, "timeout");
    if (err?.name === "AbortError") throw err;
    throw new MuxUnavailableError();
  }
  if (!res.ok) {
    const { requestId } = readMuxHeaders(res.headers);
    let body: unknown = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    throw errorFromResponse(res.status, body, requestId, res.headers.get("retry-after"));
  }
  return res;
}

function chatBody(opts: { route: MuxRoute; messages: MuxMessage[]; maxTokens?: number; temperature?: number; json?: boolean; stream?: boolean; meta: MuxCallMeta }) {
  const body: Record<string, unknown> = { model: effectiveRoute(opts.route, opts.meta.sensitive), messages: opts.messages, user: opts.meta.userId };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.json) body.response_format = { type: "json_object" };
  if (opts.stream) body.stream = true;
  return JSON.stringify(body);
}

/* ── Chat ────────────────────────────────────────────────────────────────────────────────────────────── */

/** One chat completion. */
export async function complete(opts: { route: MuxRoute; messages: MuxMessage[]; maxTokens?: number; temperature?: number; json?: boolean; meta: MuxCallMeta; signal?: AbortSignal }): Promise<MuxResult> {
  const { apiKey } = requireKey();
  const res = await post("/v1/chat/completions", {
    body: chatBody(opts),
    headers: { "content-type": "application/json", ...buildHeaders(opts.meta, apiKey) },
    signal: anySignal([AbortSignal.timeout(TIMEOUT.complete), opts.signal]),
  });
  const meta = readMuxHeaders(res.headers);
  let data: { choices?: { message?: { content?: unknown } }[] };
  try {
    data = await res.json();
  } catch {
    throw new MuxError(502, "bad_response", "mux sent an answer that isn't JSON.", meta.requestId);
  }
  return { text: messageText(data.choices?.[0]?.message?.content).replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, ""), ...meta };
}

type Chunk = { choices?: { delta?: { content?: unknown } }[]; error?: { message?: string; type?: string; code?: number } };

/** Streamed chat completion: yields text deltas, then resolves meta. */
export async function* stream(opts: { route: MuxRoute; messages: MuxMessage[]; maxTokens?: number; temperature?: number; meta: MuxCallMeta; signal?: AbortSignal }): AsyncGenerator<string, Omit<MuxResult, "text">> {
  const { apiKey } = requireKey();
  // Abort when the caller aborts, when the connection takes too long, or when no bytes arrive for a while.
  const idle = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => idle.abort(new DOMException("mux stopped sending", "TimeoutError")), ms);
  };
  arm(TIMEOUT.connect);
  const signal = anySignal([idle.signal, opts.signal]);
  try {
    const res = await post("/v1/chat/completions", {
      body: chatBody({ ...opts, stream: true }),
      headers: { "content-type": "application/json", accept: "text/event-stream", ...buildHeaders(opts.meta, apiKey) },
      signal,
    });
    const meta = readMuxHeaders(res.headers);
    if (!res.body) throw new MuxError(502, "bad_response", "mux sent an empty stream.", meta.requestId);
    arm(TIMEOUT.idle);
    try {
      for await (const ev of readSse(res.body)) {
        arm(TIMEOUT.idle);
        if (ev.data === "[DONE]") break;
        if (!ev.data) continue;
        let chunk: Chunk;
        try { chunk = JSON.parse(ev.data); } catch { continue; }
        if (chunk.error) {
          // mux reports a failure after streaming started as the stream's last event.
          const status = typeof chunk.error.code === "number" ? chunk.error.code : 502;
          throw errorFromResponse(status, chunk, meta.requestId, null);
        }
        const text = messageText(chunk.choices?.[0]?.delta?.content);
        if (text) yield text;
      }
    } catch (e) {
      if (e instanceof MuxError) throw e;
      if (idle.signal.aborted && !opts.signal?.aborted) throw new MuxUnavailableError("The model gateway (mux) stopped answering.", 0, "timeout", meta.requestId);
      throw e;
    }
    return meta;
  } finally {
    clearTimeout(timer);
  }
}

/** A JSON object validated by the caller's parser (retries once on invalid JSON). */
export async function completeJson<T>(opts: { route: MuxRoute; messages: MuxMessage[]; parse: (v: unknown) => T; maxTokens?: number; meta: MuxCallMeta }): Promise<T> {
  const first = await complete({ route: opts.route, messages: opts.messages, maxTokens: opts.maxTokens, temperature: 0, json: true, meta: opts.meta });
  try {
    return opts.parse(extractJson(first.text));
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    const retry = await complete({
      route: opts.route,
      maxTokens: opts.maxTokens,
      temperature: 0,
      json: true,
      meta: opts.meta,
      messages: [
        ...opts.messages,
        { role: "assistant", content: first.text.slice(0, 8000) },
        { role: "user", content: `That answer could not be used: ${reason.slice(0, 1000)}\nReply again with only the corrected JSON object, nothing else.` },
      ],
    });
    return opts.parse(extractJson(retry.text));
  }
}

/* ── Embeddings, speech, health ──────────────────────────────────────────────────────────────────────── */

/** 1024-dim embeddings through mux's `embed` route (bge-m3). Returns null when mux is unreachable. */
export async function embed(texts: string[], meta: MuxCallMeta): Promise<number[][] | null> {
  if (!texts.length) return [];
  const { apiKey } = muxConfig();
  if (!apiKey) return null;
  try {
    const res = await post("/v1/embeddings", {
      body: JSON.stringify({ model: "embed", input: texts, user: meta.userId }),
      headers: { "content-type": "application/json", ...buildHeaders(meta, apiKey) },
      signal: AbortSignal.timeout(TIMEOUT.embed),
    });
    const data = (await res.json()) as { data?: { index?: number; embedding?: number[] }[] };
    const rows = data.data ?? [];
    if (rows.length !== texts.length) return null;
    const out: number[][] = new Array(texts.length);
    rows.forEach((r, i) => { out[typeof r.index === "number" ? r.index : i] = r.embedding ?? []; });
    return out.every((v) => Array.isArray(v) && v.length > 0) ? out : null;
  } catch (e) {
    if (e instanceof MuxUnavailableError || e instanceof MuxAuthError) return null;
    if (e instanceof MuxError && e.status >= 500) return null;
    throw e;
  }
}

/** Speech to text through mux's /v1/audio/transcriptions. */
export async function transcribe(file: Blob, filename: string, meta: MuxCallMeta): Promise<{ text: string; segments: { start: number; end: number; text: string }[] }> {
  const { apiKey } = requireKey();
  const form = new FormData();
  form.append("model", "transcribe");
  form.append("response_format", "verbose_json");
  form.append("file", file, filename || "audio");
  const res = await post("/v1/audio/transcriptions", {
    body: form,
    headers: buildHeaders(meta, apiKey, ["transcription"]),
    signal: AbortSignal.timeout(TIMEOUT.transcribe),
  });
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("json")) return { text: (await res.text()).trim(), segments: [] };
  const data = (await res.json()) as { text?: string; segments?: { start?: number; end?: number; text?: string }[] };
  const segments = (data.segments ?? [])
    .filter((s) => typeof s.text === "string")
    .map((s) => ({ start: Number(s.start) || 0, end: Number(s.end) || Number(s.start) || 0, text: String(s.text).trim() }));
  return { text: (data.text ?? segments.map((s) => s.text).join(" ")).trim(), segments };
}

export type MuxHealth = {
  /** Reachable and configured: model calls should work. */
  ok: boolean;
  reachable: boolean;
  /** MUX_API_KEY is set. */
  configured: boolean;
  /** Plain-English explanation for the UI. */
  detail: string;
  /** Models mux has loaded right now (when it says). */
  loaded: string[];
};

let healthCache: { at: number; value: MuxHealth } | null = null;

/** Is mux up and configured? Cached for 10 s; never throws. GET /health needs no key. */
export async function muxHealth(opts: { fresh?: boolean } = {}): Promise<MuxHealth> {
  if (!opts.fresh && healthCache && Date.now() - healthCache.at < 10_000) return healthCache.value;
  const { baseUrl, apiKey } = muxConfig();
  const configured = !!apiKey;
  let value: MuxHealth;
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(TIMEOUT.health), cache: "no-store" });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; loaded?: unknown };
    const reachable = res.ok && body.ok !== false;
    const loaded = Array.isArray(body.loaded) ? body.loaded.filter((x): x is string => typeof x === "string") : [];
    value = {
      ok: reachable && configured, reachable, configured, loaded,
      detail: !reachable ? `mux answered HTTP ${res.status}.`
        : !configured ? "mux is running, but MUX_API_KEY is not set."
        : "mux is running.",
    };
  } catch {
    value = { ok: false, reachable: false, configured, loaded: [], detail: "mux can't be reached." };
  }
  healthCache = { at: Date.now(), value };
  return value;
}
