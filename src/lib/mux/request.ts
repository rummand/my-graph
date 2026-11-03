/** Pure request helpers for the mux client (headers, routes, JSON extraction). Unit-tested. */
import type { MuxCallMeta, MuxRoute } from "./index";

export const DEFAULT_BASE_URL = "http://127.0.0.1:7070";

export type MuxConfig = { baseUrl: string; apiKey: string };

export function muxConfig(env: Record<string, string | undefined> = process.env): MuxConfig {
  return {
    baseUrl: (env.MUX_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    apiKey: env.MUX_API_KEY?.trim() ?? "",
  };
}

/** Sensitive data stays on local models: the `agent` route (local Qwen) with fallback to cloud disabled. */
export function effectiveRoute(route: MuxRoute, sensitive?: boolean): MuxRoute {
  if (!sensitive) return route;
  // Images still need a vision model; mux keeps it local because of x-mux-no-fallback and the tenant's border.
  return route === "vision" ? "vision" : "agent";
}

const HEADER_SAFE = (s: string) => s.replace(/[^\x20-\x7e]/g, "").slice(0, 200);

export function buildHeaders(meta: MuxCallMeta, apiKey: string, extraTags: string[] = []): Record<string, string> {
  const tags = ["my-graph", ...extraTags];
  if (meta.sensitive) tags.push("sensitive");
  const h: Record<string, string> = {
    "x-mux-agent": HEADER_SAFE(meta.agent || "my-graph"),
    "x-mux-user": HEADER_SAFE(meta.userId),
    "x-mux-tags": [...new Set(tags.map((t) => HEADER_SAFE(t.replace(/,/g, " ")).trim()).filter(Boolean))].join(","),
  };
  if (meta.traceId) h["x-mux-trace-id"] = HEADER_SAFE(meta.traceId);
  if (meta.sensitive) h["x-mux-no-fallback"] = "1";
  if (apiKey) h.authorization = `Bearer ${apiKey}`;
  return h;
}

/** Response headers mux sets on every answer. */
export function readMuxHeaders(headers: Headers): { model: string | null; route: string | null; requestId: string | null } {
  const get = (n: string) => headers.get(n)?.trim() || null;
  return { model: get("x-mux-model"), route: get("x-mux-route"), requestId: get("x-mux-request-id") };
}

/**
 * The JSON object in a model's answer: tolerates ```json fences, a <think> preamble and prose around the object.
 * Throws SyntaxError with a short reason when there is none.
 */
export function extractJson(text: string): unknown {
  let t = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) t = fence[1].trim();
  try {
    return JSON.parse(t);
  } catch {
    const start = t.search(/[[{]/);
    if (start < 0) throw new SyntaxError("The answer contained no JSON object.");
    const open = t[start];
    const close = open === "{" ? "}" : "]";
    const end = t.lastIndexOf(close);
    if (end <= start) throw new SyntaxError("The JSON object in the answer was cut off.");
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch (e) {
      throw new SyntaxError(`The answer's JSON did not parse: ${(e as Error).message}`);
    }
  }
}

/** One text from a chat completion's message content (string or content parts). */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (p && typeof p === "object" && "text" in p && typeof p.text === "string" ? p.text : "")).join("");
  return "";
}
