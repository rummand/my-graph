/**
 * A Model Context Protocol client over Streamable HTTP, written with plain requests (no SDK): initialize (and the
 * initialized notification), ping, tools/list and tools/call, resources/list and resources/read. Works with servers
 * that answer statelessly as plain JSON (Record) and with ones that answer as SSE or hand out an Mcp-Session-Id.
 *
 * Auth is a bearer token from `token()` (an API key, or an OAuth access token the caller keeps fresh); a 401 is an
 * McpError("auth") carrying the WWW-Authenticate header, which says where to sign in (RFC 9728). Every call has a
 * timeout, and calls are spaced to stay under `perMinute` (per server address, across clients in this process).
 */
import { McpError } from "./errors";
import { LATEST_PROTOCOL, notification, PROTOCOL_VERSIONS, request, resultFor } from "./jsonrpc";
import { resourcesFrom, toolOutcome, toolsFrom, type McpResourceInfo, type McpToolInfo, type ToolOutcome } from "./tools";
import { guardedTransport, type Transport } from "./transport";

export type McpServerInfo = { name: string | null; title: string | null; version: string | null; protocolVersion: string; instructions: string | null; capabilities: Record<string, unknown> };

export type McpClientOptions = {
  url: string;
  /** The bearer token for each request (null: none). Called once per request so a refreshed token is picked up. */
  token?: () => Promise<string | null> | string | null;
  transport?: Transport;
  timeoutMs?: number;
  perMinute?: number;
  signal?: AbortSignal;
  /** Extra headers (never the Authorization header). */
  headers?: Record<string, string>;
};

/* ── Spacing calls per server (a simple per-process limiter) ─────────────────────────────────────────── */

const g = globalThis as unknown as { __mgMcpRate?: Map<string, number[]> };
const calls = (g.__mgMcpRate ??= new Map<string, number[]>());

/** Wait until one more call fits in the last minute's budget for this key. Exported for tests. */
export async function spaceCall(key: string, perMinute: number, now: () => number = Date.now, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<void> {
  for (;;) {
    const t = now();
    const recent = (calls.get(key) ?? []).filter((x) => t - x < 60_000);
    if (recent.length < perMinute) {
      recent.push(t);
      calls.set(key, recent);
      return;
    }
    const wait = 60_000 - (t - recent[0]) + 5;
    if (wait > 15_000) throw new McpError("Too many requests to this server right now. Try again in a minute.", "rateLimited");
    calls.set(key, recent);
    await sleep(wait);
  }
}

export class McpClient {
  private nextId = 1;
  private sessionId: string | null = null;
  private protocol: string = LATEST_PROTOCOL;
  private initialized: McpServerInfo | null = null;
  private readonly transport: Transport;

  constructor(private readonly opts: McpClientOptions) {
    this.transport = opts.transport ?? guardedTransport();
  }

  get server(): McpServerInfo | null {
    return this.initialized;
  }

  private async post(body: unknown, expectAnswer: boolean): Promise<{ text: string; type: string }> {
    const key = (() => { try { return new URL(this.opts.url).host; } catch { return this.opts.url; } })();
    await spaceCall(key, this.opts.perMinute ?? 60);
    const token = await this.opts.token?.();
    const headers: Record<string, string> = {
      ...(this.opts.headers ?? {}),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(this.initialized ? { "mcp-protocol-version": this.protocol } : {}),
      ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    };
    const res = await this.transport({ url: this.opts.url, method: "POST", headers, body: JSON.stringify(body), timeoutMs: this.opts.timeoutMs ?? 30_000, signal: this.opts.signal, maxBytes: 16 * 1024 * 1024 });
    const sid = res.headers["mcp-session-id"];
    if (sid && /^[\x21-\x7e]{1,200}$/.test(sid)) this.sessionId = sid;
    if (res.status === 401) throw new McpError("The server wants you to sign in again.", "auth", { status: 401, wwwAuthenticate: res.headers["www-authenticate"] ?? null });
    if (res.status === 403) throw new McpError("The server refused: this key or sign-in may not do that.", "forbidden", { status: 403 });
    if (res.status === 404 && this.sessionId) {
      // The server forgot our session: start again once.
      this.sessionId = null;
      this.initialized = null;
      throw new McpError("The server ended the session.", "protocol", { status: 404 });
    }
    if (res.status === 429) throw new McpError("The server asked us to slow down.", "rateLimited", { status: 429, retryAfter: res.headers["retry-after"] ?? null });
    if (res.status >= 500) throw new McpError(`The server had a problem (HTTP ${res.status}).`, "serverError", { status: res.status });
    if (res.status === 202 || !expectAnswer) return { text: "", type: "" };
    if (res.status < 200 || res.status >= 300) throw new McpError(`The server answered with HTTP ${res.status}. Is this the MCP address?`, "http", { status: res.status });
    return { text: res.body.toString("utf8"), type: res.headers["content-type"] ?? "application/json" };
  }

  private async rpc(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.initialized && method !== "initialize") await this.initialize();
    const id = this.nextId++;
    try {
      const { text, type } = await this.post(request(id, method, params), true);
      return resultFor(id, text, type);
    } catch (e) {
      // A server that dropped our session gets one fresh start.
      if (e instanceof McpError && e.extra.status === 404 && method !== "initialize" && !this.initialized) {
        await this.initialize();
        const again = this.nextId++;
        const { text, type } = await this.post(request(again, method, params), true);
        return resultFor(again, text, type);
      }
      throw e;
    }
  }

  async initialize(): Promise<McpServerInfo> {
    if (this.initialized) return this.initialized;
    const id = this.nextId++;
    const { text, type } = await this.post(request(id, "initialize", {
      protocolVersion: LATEST_PROTOCOL,
      capabilities: {},
      clientInfo: { name: "my-graph", title: "My Graph", version: "1.0.0" },
    }), true);
    const r = (resultFor(id, text, type) ?? {}) as { protocolVersion?: string; serverInfo?: { name?: string; title?: string; version?: string }; instructions?: string; capabilities?: Record<string, unknown> };
    const version = typeof r.protocolVersion === "string" ? r.protocolVersion : LATEST_PROTOCOL;
    if (!(PROTOCOL_VERSIONS as readonly string[]).includes(version)) throw new McpError(`The server speaks MCP version ${version}, which My Graph doesn't know.`, "protocol");
    this.protocol = version;
    this.initialized = {
      name: r.serverInfo?.name ?? null, title: r.serverInfo?.title ?? null, version: r.serverInfo?.version ?? null,
      protocolVersion: version, instructions: typeof r.instructions === "string" ? r.instructions.slice(0, 4000) : null, capabilities: r.capabilities ?? {},
    };
    await this.post(notification("notifications/initialized"), false).catch(() => {});
    return this.initialized;
  }

  async ping(): Promise<void> {
    await this.rpc("ping");
  }

  /** Every tool, following `nextCursor` (at most 20 pages). */
  async listTools(): Promise<McpToolInfo[]> {
    const out: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = (await this.rpc("tools/list", cursor ? { cursor } : undefined)) as { nextCursor?: string } | null;
      out.push(...toolsFrom(r));
      cursor = typeof r?.nextCursor === "string" && r.nextCursor ? r.nextCursor : undefined;
      if (!cursor) break;
    }
    return out;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> {
    return toolOutcome(await this.rpc("tools/call", { name, arguments: args }));
  }

  /** Resources, when the server has them (an empty list when it doesn't do resources). */
  async listResources(): Promise<McpResourceInfo[]> {
    if (this.initialized && !this.initialized.capabilities.resources) return [];
    try {
      return resourcesFrom(await this.rpc("resources/list"));
    } catch (e) {
      if (e instanceof McpError && (e.code === "toolMissing" || e.extra.rpcCode === -32601)) return [];
      throw e;
    }
  }

  async readResource(uri: string): Promise<{ uri: string; mimeType: string | null; text: string | null }[]> {
    const r = (await this.rpc("resources/read", { uri })) as { contents?: { uri?: string; mimeType?: string; text?: string }[] } | null;
    return (r?.contents ?? []).map((c) => ({ uri: String(c.uri ?? uri), mimeType: c.mimeType ?? null, text: typeof c.text === "string" ? c.text.slice(0, 200_000) : null }));
  }
}
