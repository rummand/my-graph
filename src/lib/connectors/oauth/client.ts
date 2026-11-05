/**
 * Authorised API calls for a provider connector. Every request goes through the SSRF-guarded transport (https only,
 * public addresses only; localhost only in development), carries the connection's bearer token, refreshes once on a
 * 401, and sorts the provider's answer into the connector errors:
 *   401 after a refresh → needs you (sign in again)       429, 5xx, network → will retry (back-off)
 *   403 for missing scopes → needs you (sign in again and allow access)
 * Everything else (200, 404, 409, 410 …) comes back to the caller, who decides whether it means "cursor expired".
 * The token never appears in an error message: answers are summarised, never echoed.
 */
import { McpError } from "@/lib/mcp-client/errors";
import type { HttpRequest, HttpResponse, Transport } from "@/lib/mcp-client/transport";
import { needsYou, willRetry } from "../errors";

export type ApiRequest = {
  url: string;
  method?: "GET" | "POST" | "DELETE";
  headers?: Record<string, string>;
  body?: string;
  maxBytes?: number;
  timeoutMs?: number;
  /** Don't send the bearer token (a pre-authenticated download address on another host). */
  noAuth?: boolean;
};

export type ApiResponse = HttpResponse & { json<T = Record<string, unknown>>(): T | null };

export type Api = (req: ApiRequest) => Promise<ApiResponse>;

export type ApiOptions = {
  transport: Transport;
  token(): Promise<string>;
  /** Refresh after a 401 (returns the new token). */
  refresh(): Promise<string>;
  signal?: AbortSignal;
  throttle?: () => Promise<void>;
  /** "Google", "Microsoft", "Dropbox" for messages. */
  who: string;
};

function withJson(res: HttpResponse): ApiResponse {
  return {
    ...res,
    json<T>() {
      try { return JSON.parse(res.body.toString("utf8")) as T; } catch { return null; }
    },
  };
}

/** A transport failure as a connector error (private address: needs you; the rest: try again later). */
export function transportError(e: unknown, who: string): Error {
  if (e instanceof McpError) {
    if (e.code === "privateHost" || e.code === "badUrl") return needsYou(`${who}'s address can't be reached from here: ${e.message}`, "privateHost");
    if (e.code === "timeout") return willRetry(`${who} took too long to answer.`, "timeout");
    if (e.code === "tooLarge") return willRetry(`${who} answered with more than My Graph reads at once.`, "tooLarge");
    return willRetry(`Couldn't reach ${who} (${e.message}).`, "network");
  }
  return e instanceof Error ? e : new Error(String(e));
}

/** Seconds to wait from a Retry-After header, if any (for the log). */
export function retryAfter(headers: Record<string, string>): number | null {
  const v = headers["retry-after"];
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, Math.round(n));
  const d = Date.parse(v);
  return Number.isFinite(d) ? Math.max(0, Math.round((d - Date.now()) / 1000)) : null;
}

/** Does a 403 say the sign-in lacks a permission (versus "this one item is not yours")? */
export function isScopeProblem(body: string): boolean {
  return /insufficient(Permissions|_scope|Scope)|ACCESS_TOKEN_SCOPE_INSUFFICIENT|missing_scope|ErrorAccessDenied|Authorization_RequestDenied/i.test(body);
}

export function makeApi(o: ApiOptions): Api {
  const send = async (req: ApiRequest, token: string | null): Promise<HttpResponse> => {
    await o.throttle?.();
    const r: HttpRequest = {
      url: req.url, method: req.method ?? "GET", body: req.body, signal: o.signal,
      timeoutMs: req.timeoutMs ?? 60_000, maxBytes: req.maxBytes ?? 8 * 1024 * 1024, follow: 0,
      headers: { accept: "application/json", ...(req.headers ?? {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    };
    try {
      return await o.transport(r);
    } catch (e) {
      throw transportError(e, o.who);
    }
  };
  return async (req) => {
    let res = await send(req, req.noAuth ? null : await o.token());
    if (res.status === 401 && !req.noAuth) {
      res = await send(req, await o.refresh());
      if (res.status === 401) throw needsYou(`${o.who} no longer accepts the sign-in. Sign in again to keep it connected.`, "signInAgain");
    }
    if (res.status === 403 && isScopeProblem(res.body.toString("utf8").slice(0, 4000))) {
      throw needsYou(`${o.who} says My Graph wasn't allowed to read this. Sign in again and allow access on ${o.who}'s page.`, "scopeMissing");
    }
    if (res.status === 429) {
      const s = retryAfter(res.headers);
      throw willRetry(`${o.who} asked us to slow down${s ? ` (for ${s} seconds)` : ""}.`, "rateLimited");
    }
    if (res.status >= 500) throw willRetry(`${o.who} had a problem (HTTP ${res.status}). It will try again.`, "serverError");
    return withJson(res);
  };
}

/** An answer the caller didn't expect: say it plainly (never echoing the body, which may quote a token). */
export function unexpected(res: HttpResponse, who: string, what: string): Error {
  if (res.status === 403) return needsYou(`${who} refused to show ${what} (HTTP 403).`, "forbidden");
  if (res.status === 404) return needsYou(`${who} couldn't find ${what}. It may have been removed or renamed.`, "notFound");
  return needsYou(`${who} answered HTTP ${res.status} for ${what}.`, "httpOther");
}

/** Read a JSON body or fail plainly. */
export function bodyOf<T>(res: ApiResponse, who: string): T {
  const b = res.json<T>();
  if (b == null) throw willRetry(`${who} answered with something that isn't JSON.`, "serverError");
  return b;
}
