/**
 * A small read-only Famly client (server-only, no DB). Every request goes through the connectors' SSRF-guarded
 * transport. Only reads: the sign-in mutation (which only issues a token), GET requests, and the GetChildNotes query.
 * Nothing here can post, like, comment, answer a message or mark anything as read.
 */
import { createHash } from "node:crypto";
import type { Transport } from "@/lib/mcp-client/transport";
import { AUTHENTICATE, CHILD_NOTES, FAMLY_BASE, loginResult, type LoginResult } from "./map";

export class FamlyError extends Error {
  constructor(message: string, readonly kind: "auth" | "challenged" | "http" | "network" | "shape", readonly status?: number) {
    super(message);
    this.name = "FamlyError";
  }
}

/** Only these GET paths are ever called. */
const READ_PATHS = [/^\/api\/me\/me\/me$/, /^\/api\/feed\/feed\/feed$/, /^\/api\/v2\/conversations$/, /^\/api\/v2\/conversations\/[A-Za-z0-9-]+$/];
/** Only these GraphQL operations are ever sent (Authenticate only issues a token). */
const OPERATIONS = new Map([["Authenticate", AUTHENTICATE], ["GetChildNotes", CHILD_NOTES]]);

/** A stable device id per connection (Famly ties sign-ins to a device). */
export const deviceIdFor = (connectionId: string) => {
  const h = createHash("md5").update(`mygraph:${connectionId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

export class FamlyApi {
  private token: string | null = null;
  constructor(private readonly o: { transport: Transport; base?: string; throttle?: () => Promise<void>; signal?: AbortSignal }) {}

  private get base() { return (this.o.base ?? FAMLY_BASE).replace(/\/$/, ""); }

  private async send(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    await this.o.throttle?.();
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.token) headers["x-famly-accesstoken"] = this.token;
    let res;
    try {
      res = await this.o.transport({ url: `${this.base}${path}`, method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: this.o.signal, timeoutMs: 30_000, maxBytes: 16 * 1024 * 1024 });
    } catch (e) {
      // The transport's messages never contain headers, so never the token.
      throw new FamlyError(e instanceof Error ? e.message : "Famly couldn't be reached.", "network");
    }
    if (res.status === 401 || res.status === 403) throw new FamlyError("Famly ended the sign-in.", "auth", res.status);
    if (res.status !== 200) throw new FamlyError(`Famly answered HTTP ${res.status}.`, "http", res.status);
    try {
      return JSON.parse(res.body.toString("utf8"));
    } catch {
      throw new FamlyError("Famly's answer wasn't JSON.", "shape");
    }
  }

  async login(email: string, password: string, deviceId: string): Promise<void> {
    const body = await this.graphql("Authenticate", { email, password, deviceId, legacy: false }, true);
    const r: LoginResult = loginResult(body);
    if (r.kind === "ok") { this.token = r.accessToken; return; }
    if (r.kind === "challenged") throw new FamlyError("Famly asks for a second step (two-factor or choosing an account) that this connection can't do.", "challenged");
    if (r.kind === "failed") throw new FamlyError(r.message, "auth");
    throw new FamlyError("Famly's sign-in answer had an unexpected shape.", "shape");
  }

  async get(path: string, params: Record<string, string | number | undefined> = {}): Promise<unknown> {
    if (!READ_PATHS.some((r) => r.test(path))) throw new FamlyError(`"${path}" is not a read and is never called.`, "shape");
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
    return this.send("GET", `${path}${q.size ? `?${q.toString()}` : ""}`);
  }

  async graphql(operation: string, variables: Record<string, unknown>, raw = false): Promise<unknown> {
    const query = OPERATIONS.get(operation);
    if (!query) throw new FamlyError(`"${operation}" is never sent.`, "shape");
    const body = await this.send("POST", `/graphql?${operation}`, { operationName: operation, variables, query });
    if (raw) return body;
    const errors = (body as { errors?: { message?: string }[] })?.errors;
    if (errors?.length) throw new FamlyError(`Famly refused ${operation}: ${String(errors[0]?.message ?? "").slice(0, 160)}`, "shape");
    return (body as { data?: unknown })?.data;
  }

  me() { return this.get("/api/me/me/me"); }
  feed(olderThan?: string, cursor?: string) { return this.get("/api/feed/feed/feed", { first: 20, olderThan, cursor }); }
  conversations() { return this.get("/api/v2/conversations"); }
  conversation(id: string) { return this.get(`/api/v2/conversations/${encodeURIComponent(id)}`); }
  childNotes(childId: string, cursor: string | null, limit = 20) {
    return this.graphql("GetChildNotes", { childId, cursor, limit, noteTypes: ["Classic"], parentVisible: true, safeguardingConcern: false, sensitive: false });
  }

  /** Download a picture or file Famly links to (img.famly.co, its CDN). Same guard; the token goes only to Famly's own host. */
  async download(url: string, maxBytes: number): Promise<{ bytes: Buffer; mime: string | null }> {
    // Each redirect hop is checked again by the guard. The transport resends headers on a redirect, so a request
    // that carries the Famly token never follows one.
    await this.o.throttle?.();
    // Famly's own host wants the token (famly-fetch: "v2-urls demand x-famly-accesstoken"); its image CDN gets nothing.
    const own = (() => { try { return new URL(url).host === new URL(this.base).host; } catch { return false; } })();
    const headers: Record<string, string> = own && this.token ? { "x-famly-accesstoken": this.token } : {};
    const res = await this.o.transport({ url, method: "GET", headers, signal: this.o.signal, timeoutMs: 60_000, maxBytes, follow: own ? 0 : 2 })
      .catch((e) => { throw new FamlyError(e instanceof Error ? e.message : "The picture couldn't be fetched.", "network"); });
    if (res.status !== 200) throw new FamlyError(`The picture answered HTTP ${res.status}.`, "http", res.status);
    return { bytes: res.body, mime: res.headers["content-type"] ?? null };
  }
}
