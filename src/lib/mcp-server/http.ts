/**
 * The MCP server and the OAuth endpoints over HTTP (server-only), thin around tools.ts and oauth.ts, as Record's
 * mcp-http.ts and oauth-http.ts are. Bearer tokens only, never in the address (proxies log addresses). A 401 says where
 * to sign in (`WWW-Authenticate: Bearer resource_metadata=…`). No session is kept and nothing is streamed, so GET and
 * DELETE on /api/mcp answer 405 as the Streamable HTTP transport allows. Every tool call is audit-logged.
 */
import { NextResponse } from "next/server";
import { writeAudit } from "@/lib/auth/audit";
import { viewerFor } from "@/lib/auth/viewer-for";
import { appDeps } from "./deps";
import { credentialForKey } from "./keys";
import { challenge, credentialForAccessToken, mcpResource, type Answer } from "./oauth";
import { rateLimited } from "./rate";
import { dbStore } from "./store-db";
import { bearerOf, isAccessToken, isKeyToken } from "./tokens";
import { handleBody, PROTOCOL_VERSIONS, type CallRecord } from "./tools";
import type { Credential } from "./types";

/**
 * The address people paste and tokens are bound to. APP_URL when it is set (so a forged Host can't change what a token
 * is for); else the forwarded host (Railway, a proxy), else the request's own.
 */
export function originOf(request: Request, env: Record<string, string | undefined> = process.env): string {
  return originFromHeaders(request.headers, new URL(request.url), env);
}

/** The same, from a page's headers (`headers()` in a server component). */
export function originFromHeaders(h: Headers, url?: URL, env: Record<string, string | undefined> = process.env): string {
  if (env.APP_URL) { try { return new URL(env.APP_URL).origin; } catch { /* fall through */ } }
  const host = h.get("x-forwarded-host")?.split(",")[0]?.trim() || h.get("host");
  const proto = h.get("x-forwarded-proto")?.split(",")[0]?.trim() || url?.protocol.replace(":", "") || (host?.startsWith("localhost") || host?.startsWith("127.0.0.1") ? "http" : "https");
  return host ? `${proto}://${host}` : url?.origin ?? "http://localhost:3000";
}

export const ipOf = (request: Request) => request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "";

/** Bearer-token endpoints answer any origin (never with credentials: nothing here reads a cookie). */
export const CORS = {
  "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id", "access-control-expose-headers": "www-authenticate",
  "access-control-max-age": "86400",
};
export const preflight = () => new Response(null, { status: 204, headers: CORS });

const rpcError = (status: number, message: string, headers: Record<string, string> = {}) =>
  NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message } }, { status, headers: { ...CORS, "cache-control": "no-store", ...headers } });

/** Who a bearer token is: a personal key or an app's access token for this server. */
export async function credentialOf(token: string, origin: string): Promise<Credential | null> {
  if (isKeyToken(token)) return credentialForKey(dbStore, token);
  if (isAccessToken(token)) return credentialForAccessToken(dbStore, token, mcpResource(origin));
  return null;
}

function auditCall(householdId: string, cred: Credential, graphId: string, r: CallRecord) {
  void writeAudit({ id: cred.userId, householdId }, "mcp.call", { type: "mcp_credential", id: cred.id }, {
    tool: r.tool, ok: r.ok, ms: r.ms, via: cred.kind, app: cred.name, graphId, ...(r.error ? { error: r.error } : {}),
  });
}

export async function serveMcp(request: Request): Promise<Response> {
  const origin = originOf(request);
  const token = bearerOf(request.headers.get("authorization"));
  const cred = token ? await credentialOf(token, origin).catch(() => null) : null;
  if (!cred) {
    return rpcError(401, "My Graph's MCP server needs you to sign in: connect it from your assistant, or send a personal access key (made in My Graph under Settings, AI apps) as Authorization: Bearer mgk_….",
      { "www-authenticate": challenge(origin, token ? "invalid_token" : undefined) });
  }
  const wait = rateLimited(cred.id);
  if (wait !== null) return rpcError(429, `Too many requests. Try again in ${wait} seconds.`, { "retry-after": String(wait) });
  const version = request.headers.get("mcp-protocol-version");
  if (version && !PROTOCOL_VERSIONS.includes(version)) return rpcError(400, `My Graph speaks MCP ${PROTOCOL_VERSIONS.join(", ")}.`);
  const viewer = await viewerFor(cred.userId, cred.graphId).catch(() => null);
  if (!viewer) {
    return rpcError(401, "This key or connection is for a graph you are no longer in. Make a new one in My Graph.", { "www-authenticate": challenge(origin, "invalid_token") });
  }
  const raw = await request.text();
  if (raw.length > 1_000_000) return rpcError(413, "That message is too large.");
  const out = await handleBody({ viewer, cred, origin, deps: appDeps }, raw, (r) => auditCall(viewer.householdId, cred, viewer.graphId, r));
  if (out.status === 202) return new Response(null, { status: 202, headers: CORS });
  return NextResponse.json(out.body, { status: out.status, headers: { ...CORS, "cache-control": "no-store" } });
}

export const notHere = () => new Response(null, { status: 405, headers: { ...CORS, allow: "POST, OPTIONS" } });

/** An OAuth answer as a response: never cached. */
export const oauthOut = (a: Answer) => NextResponse.json(a.body ?? {}, { status: a.status, headers: { ...CORS, "cache-control": "no-store", pragma: "no-cache", ...(a.headers ?? {}) } });
