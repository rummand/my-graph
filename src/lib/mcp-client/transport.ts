/**
 * HTTP for MCP servers and the sound they hand out, with the connectors' SSRF guard on every hop: the address is
 * checked as a URL (https only, standard port, no user:password) and again on the address actually connected to (a DNS
 * lookup hook), so a name that resolves to a private address is refused. localhost works only in development
 * (NODE_ENV=development) or with CONNECTORS_ALLOW_PRIVATE=1, exactly as for calendar links. Server-only.
 *
 * Two shapes: `guardedRequest` reads a whole (size-limited) answer for JSON-RPC and OAuth; `guardedStream` hands the
 * body on as a stream for the audio proxy. Neither follows a redirect unless asked, and every hop is checked again.
 */
import http from "node:http";
import https from "node:https";
import type { lookup as dnsLookup } from "node:dns";
import { Readable } from "node:stream";
import { checkUrl, guardedLookup } from "@/lib/connectors/ssrf";
import { McpError } from "./errors";

export type Env = Record<string, string | undefined>;

export type HttpRequest = {
  url: string;
  method?: "GET" | "POST" | "DELETE" | "HEAD";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  /** Follow up to this many redirects (each checked again). 0 = hand the redirect back. */
  follow?: number;
};

export type HttpResponse = { status: number; headers: Record<string, string>; body: Buffer; url: string };

/** What the MCP client and OAuth helpers send requests through: the guarded one in the app, a fake in the tests. */
export type Transport = (req: HttpRequest) => Promise<HttpResponse>;

const UA = "MyGraph/1 (+MCP client)";

/** Check a server address a person typed or a server pointed us to. Throws McpError("badUrl" | "privateHost"). */
export function checkServerUrl(raw: string, env: Env = process.env): URL {
  try {
    return checkUrl(raw, env);
  } catch (e) {
    const code = (e as { code?: string }).code;
    throw new McpError(e instanceof Error ? e.message : "That address can't be used.", code === "privateHost" ? "privateHost" : "badUrl");
  }
}

function headersOf(res: http.IncomingMessage): Record<string, string> {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers)) if (v != null) h[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
  return h;
}

function open(url: URL, req: HttpRequest, env: Env): Promise<{ res: http.IncomingMessage; abort: () => void }> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const r = mod.request(url, {
      method: req.method ?? "GET",
      headers: { "user-agent": UA, ...(req.headers ?? {}), ...(req.body !== undefined ? { "content-length": String(Buffer.byteLength(req.body)) } : {}) },
      lookup: guardedLookup(env) as unknown as typeof dnsLookup,
      timeout: req.timeoutMs ?? 30_000,
      signal: req.signal,
    }, (res) => resolve({ res, abort: () => r.destroy() }));
    r.on("timeout", () => { r.destroy(); reject(new McpError("The server took too long to answer.", "timeout")); });
    r.on("error", (e: NodeJS.ErrnoException) => {
      if (e instanceof McpError) return reject(e);
      if (e.code === "EPRIVATE") return reject(new McpError("That address points to a private network. My Graph only connects to servers on the internet.", "privateHost"));
      if (e.name === "AbortError") return reject(new McpError("The request was stopped.", "aborted"));
      if (e.code === "ENOTFOUND" || e.code === "EAI_AGAIN") return reject(new McpError(`The server "${url.hostname}" couldn't be found.`, "dns"));
      reject(new McpError(`Couldn't reach the server (${e.code ?? e.message}).`, "network"));
    });
    if (req.body !== undefined) r.write(req.body);
    r.end();
  });
}

/** One request, whole answer, size-limited. Redirects are followed only when `follow` > 0, each hop checked again. */
export function guardedTransport(env: Env = process.env): Transport {
  return async (req) => {
    let url = checkServerUrl(req.url, env);
    const maxBytes = req.maxBytes ?? 8 * 1024 * 1024;
    for (let hop = 0; ; hop++) {
      const { res, abort } = await open(url, req, env);
      const status = res.statusCode ?? 0;
      const headers = headersOf(res);
      if (status >= 300 && status < 400 && headers.location && hop < (req.follow ?? 0)) {
        res.resume();
        url = checkServerUrl(new URL(headers.location, url).toString(), env);
        continue;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      await new Promise<void>((resolve, reject) => {
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) { abort(); reject(new McpError("The server answered with far too much.", "tooLarge")); return; }
          chunks.push(c);
        });
        res.on("end", () => resolve());
        res.on("error", (e) => reject(new McpError(`The answer was cut off (${e.message}).`, "network")));
      });
      return { status, headers, body: Buffer.concat(chunks), url: url.toString() };
    }
  };
}

export type StreamResponse = { status: number; headers: Record<string, string>; body: ReadableStream<Uint8Array> | null; abort: () => void };

/**
 * A request whose body is handed on as a web stream (the audio proxy). Follows up to `follow` redirects, each checked;
 * never hands a redirect to the caller (so nothing about the upstream address reaches a browser).
 */
export async function guardedStream(req: HttpRequest, env: Env = process.env): Promise<StreamResponse> {
  let url = checkServerUrl(req.url, env);
  for (let hop = 0; hop <= (req.follow ?? 3); hop++) {
    const { res, abort } = await open(url, req, env);
    const status = res.statusCode ?? 0;
    const headers = headersOf(res);
    if (status >= 300 && status < 400 && headers.location) {
      res.resume();
      url = checkServerUrl(new URL(headers.location, url).toString(), env);
      continue;
    }
    const body = status === 204 || status === 304 || req.method === "HEAD" ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>);
    if (!body) res.resume();
    return { status, headers, body, abort };
  }
  throw new McpError("The sound's address redirected too many times.", "network");
}
