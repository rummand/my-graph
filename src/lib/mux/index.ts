/**
 * mux contract (owned by the mux/assistant workstream). Server-only.
 * mux is the household's model gateway (OpenAI + Anthropic compatible, see MUX_BASE_URL). Every model call in My
 * Graph goes through here — never call a provider directly.
 * Routes: auto · fast · agent · smart · code · multilingual · vision · embed. `sensitive: true` must keep the request
 * on local models (route to a local model and send `x-mux-no-fallback: 1`).
 */
export type MuxRoute = "auto" | "fast" | "agent" | "smart" | "vision" | "multilingual" | "code";

export type MuxMessage = { role: "system" | "user" | "assistant"; content: string | MuxContentPart[] };
export type MuxContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export type MuxCallMeta = { userId: string; agent: string; traceId?: string; sensitive?: boolean };

export type MuxResult = { text: string; model: string | null; route: string | null; requestId: string | null };

/** One chat completion. */
export async function complete(opts: { route: MuxRoute; messages: MuxMessage[]; maxTokens?: number; temperature?: number; json?: boolean; meta: MuxCallMeta }): Promise<MuxResult> {
  throw new Error("mux.complete not implemented");
}

/** Streamed chat completion: yields text deltas, then resolves meta. */
export async function* stream(opts: { route: MuxRoute; messages: MuxMessage[]; maxTokens?: number; meta: MuxCallMeta }): AsyncGenerator<string, Omit<MuxResult, "text">> {
  throw new Error("mux.stream not implemented");
}

/** A JSON object validated by the caller's parser (retries once on invalid JSON). */
export async function completeJson<T>(opts: { route: MuxRoute; messages: MuxMessage[]; parse: (v: unknown) => T; maxTokens?: number; meta: MuxCallMeta }): Promise<T> {
  throw new Error("mux.completeJson not implemented");
}

/** 1024-dim embeddings through mux's `embed` route (bge-m3). Returns null when mux is unreachable. */
export async function embed(texts: string[], meta: MuxCallMeta): Promise<number[][] | null> {
  throw new Error("mux.embed not implemented");
}

/** Speech to text through mux's /v1/audio/transcriptions. */
export async function transcribe(file: Blob, filename: string, meta: MuxCallMeta): Promise<{ text: string; segments: { start: number; end: number; text: string }[] }> {
  throw new Error("mux.transcribe not implemented");
}

/** Whether mux answers (GET /health). */
export async function muxHealth(): Promise<{ ok: boolean; detail: string }> {
  throw new Error("mux.muxHealth not implemented");
}
