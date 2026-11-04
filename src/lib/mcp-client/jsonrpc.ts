/**
 * The Model Context Protocol's JSON-RPC 2.0 over Streamable HTTP, the client side, pure: building requests and reading
 * answers. A server may answer a POST with `application/json` (one response or a batch) or with `text/event-stream`
 * (SSE events whose `data` are JSON-RPC messages; the one with our id is the answer, notifications around it are
 * ignored). Nothing here touches the network.
 */
import { McpError } from "./errors";

export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const LATEST_PROTOCOL = PROTOCOL_VERSIONS[0];

export type JsonRpcRequest = { jsonrpc: "2.0"; id?: number | string; method: string; params?: Record<string, unknown> };
export type JsonRpcResponse = { jsonrpc: "2.0"; id: number | string | null; result?: unknown; error?: { code: number; message: string; data?: unknown } };

export function request(id: number, method: string, params?: Record<string, unknown>): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) };
}

export function notification(method: string, params?: Record<string, unknown>): JsonRpcRequest {
  return { jsonrpc: "2.0", method, ...(params ? { params } : {}) };
}

/** SSE text → the `data` of each event (multi-line data joined with \n). Tolerates \r\n and a missing final blank line. */
export function sseData(text: string): string[] {
  const out: string[] = [];
  let data: string[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (raw === "") {
      if (data.length) out.push(data.join("\n"));
      data = [];
      continue;
    }
    if (raw.startsWith(":")) continue;
    const i = raw.indexOf(":");
    const field = i < 0 ? raw : raw.slice(0, i);
    const value = i < 0 ? "" : raw.slice(i + 1).replace(/^ /, "");
    if (field === "data") data.push(value);
  }
  if (data.length) out.push(data.join("\n"));
  return out;
}

function isResponse(x: unknown): x is JsonRpcResponse {
  return !!x && typeof x === "object" && (x as JsonRpcResponse).jsonrpc === "2.0" && ("result" in (x as object) || "error" in (x as object));
}

/** Every JSON-RPC response in an HTTP answer body, JSON or SSE. */
export function responsesIn(body: string, contentType: string): JsonRpcResponse[] {
  const type = contentType.toLowerCase();
  const texts = type.includes("text/event-stream") ? sseData(body) : [body];
  const out: JsonRpcResponse[] = [];
  for (const t of texts) {
    if (!t.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch {
      if (type.includes("text/event-stream")) continue; // a non-JSON event: not for us
      throw new McpError("The server's answer isn't JSON.", "protocol");
    }
    for (const m of Array.isArray(parsed) ? parsed : [parsed]) if (isResponse(m)) out.push(m);
  }
  return out;
}

/** The result for our request id, or an McpError for a JSON-RPC error / a missing answer. */
export function resultFor(id: number | string, body: string, contentType: string): unknown {
  const hit = responsesIn(body, contentType).find((r) => r.id === id);
  if (!hit) throw new McpError("The server didn't answer the request.", "protocol");
  if (hit.error) {
    const missing = hit.error.code === -32601;
    throw new McpError(hit.error.message || "The server refused the request.", missing ? "toolMissing" : "rpc", { rpcCode: hit.error.code });
  }
  return hit.result;
}
