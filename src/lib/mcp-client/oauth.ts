/**
 * OAuth 2.1 for MCP servers, as the MCP authorization specification asks: find the authorization server from the
 * protected resource's metadata (RFC 9728), read its metadata (RFC 8414, with OpenID discovery as the fallback),
 * register as a client (RFC 7591 dynamic registration), send the person to consent with PKCE (S256) and the resource
 * indicator (RFC 8707), then trade the code for tokens and refresh them. The pure parts (PKCE, URLs, header parsing)
 * are exported for tests; the network parts take a Transport so they run through the SSRF guard.
 */
import { createHash, randomBytes } from "node:crypto";
import { McpError } from "./errors";
import type { HttpResponse, Transport } from "./transport";

/* ── Pure helpers ────────────────────────────────────────────────────────────────────────────────────── */

export const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A PKCE pair: a 43–128 character verifier and its S256 challenge (RFC 7636). */
export function pkcePair(bytes = 48): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(bytes));
  return { verifier, challenge: pkceChallenge(verifier) };
}

export function pkceChallenge(verifier: string): string {
  return b64url(createHash("sha256").update(verifier).digest());
}

export function randomState(): string {
  return b64url(randomBytes(24));
}

/** `Bearer realm="x", resource_metadata="https://…", scope="read write", error="invalid_token"` → its parameters. */
export function parseWwwAuthenticate(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  const s = header.replace(/^\s*Bearer\s*/i, "");
  const re = /([a-zA-Z_][a-zA-Z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g;
  for (const m of s.matchAll(re)) out[m[1].toLowerCase()] = (m[2] ?? m[3] ?? "").replace(/\\(.)/g, "$1");
  return out;
}

/** The canonical resource for an MCP address (RFC 8707): no fragment, no trailing slash on the path, lower-case host. */
export function canonicalResource(serverUrl: string): string {
  const u = new URL(serverUrl);
  u.hash = "";
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
}

/** Where a resource's metadata may be (RFC 9728 §3.1): path-inserted first, then the root. */
export function protectedResourceMetadataUrls(serverUrl: string): string[] {
  const u = new URL(serverUrl);
  const path = u.pathname.replace(/\/+$/, "");
  const root = `${u.protocol}//${u.host}/.well-known/oauth-protected-resource`;
  return path && path !== "/" ? [`${root}${path}`, root] : [root];
}

/** Where an authorization server's metadata may be (RFC 8414 §3.1, then OpenID Connect discovery). */
export function authorizationServerMetadataUrls(issuer: string): string[] {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/+$/, "");
  const origin = `${u.protocol}//${u.host}`;
  if (!path || path === "/") return [`${origin}/.well-known/oauth-authorization-server`, `${origin}/.well-known/openid-configuration`];
  return [`${origin}/.well-known/oauth-authorization-server${path}`, `${origin}/.well-known/openid-configuration${path}`, `${origin}${path}/.well-known/openid-configuration`];
}

export type AuthServerMeta = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  code_challenge_methods_supported?: string[];
  scopes_supported?: string[];
  authorization_response_iss_parameter_supported?: boolean;
};

export function authorizeUrl(meta: Pick<AuthServerMeta, "authorization_endpoint">, p: { clientId: string; redirectUri: string; challenge: string; state: string; resource: string; scope?: string | null }): string {
  const u = new URL(meta.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", p.clientId);
  u.searchParams.set("redirect_uri", p.redirectUri);
  u.searchParams.set("code_challenge", p.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", p.state);
  u.searchParams.set("resource", p.resource);
  if (p.scope) u.searchParams.set("scope", p.scope);
  return u.toString();
}

export type Tokens = { accessToken: string; refreshToken: string | null; expiresAt: number | null; scope: string | null };

export function tokensFrom(body: unknown, now = Date.now()): Tokens {
  const b = (body ?? {}) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown; token_type?: unknown };
  if (typeof b.access_token !== "string" || !b.access_token) throw new McpError("The sign-in didn't give an access token.", "oauth");
  if (typeof b.token_type === "string" && b.token_type.toLowerCase() !== "bearer") throw new McpError(`The sign-in gave a "${b.token_type}" token; only Bearer tokens work.`, "oauth");
  const secs = Number(b.expires_in);
  return {
    accessToken: b.access_token,
    refreshToken: typeof b.refresh_token === "string" && b.refresh_token ? b.refresh_token : null,
    expiresAt: Number.isFinite(secs) && secs > 0 ? now + secs * 1000 : null,
    scope: typeof b.scope === "string" ? b.scope : null,
  };
}

/** True when the access token is gone or ends within `marginMs` (refresh first). */
export function needsRefresh(t: Pick<Tokens, "expiresAt">, now = Date.now(), marginMs = 60_000): boolean {
  return t.expiresAt != null && t.expiresAt - marginMs <= now;
}

/* ── Network: discovery, registration, tokens ────────────────────────────────────────────────────────── */

function json(res: HttpResponse): unknown {
  try {
    return JSON.parse(res.body.toString("utf8"));
  } catch {
    return null;
  }
}

async function getJson(transport: Transport, url: string): Promise<unknown | null> {
  const res = await transport({ url, method: "GET", headers: { accept: "application/json" }, timeoutMs: 15_000, maxBytes: 256 * 1024 });
  if (res.status < 200 || res.status >= 300) return null;
  return json(res);
}

export type Discovery = { resource: string; issuer: string; meta: AuthServerMeta; scopes: string[] };

/**
 * From an MCP address to its authorization server: ask the server (a 401's resource_metadata), else the well-known
 * places; then the authorization server's metadata, which must offer S256 PKCE.
 */
export async function discover(transport: Transport, serverUrl: string, wwwAuthenticate?: string | null): Promise<Discovery> {
  const hinted = parseWwwAuthenticate(wwwAuthenticate).resource_metadata;
  const candidates = [...(hinted ? [hinted] : []), ...protectedResourceMetadataUrls(serverUrl)];
  type Prm = { resource?: string; authorization_servers?: string[]; scopes_supported?: string[] };
  let prm = null as Prm | null;
  for (const url of candidates) {
    const r = (await getJson(transport, url).catch(() => null)) as Prm | null;
    if (r && Array.isArray(r.authorization_servers) && r.authorization_servers.length) { prm = r; break; }
  }
  // No resource metadata: an older server that is its own authorization server.
  const issuer = prm?.authorization_servers?.[0] ?? new URL(serverUrl).origin;
  let meta: AuthServerMeta | null = null;
  for (const url of authorizationServerMetadataUrls(issuer)) {
    const r = (await getJson(transport, url).catch(() => null)) as AuthServerMeta | null;
    if (r && typeof r.authorization_endpoint === "string" && typeof r.token_endpoint === "string") { meta = r; break; }
  }
  if (!meta) throw new McpError("This server doesn't say where to sign in. Use an API key instead.", "oauth");
  if (meta.code_challenge_methods_supported && !meta.code_challenge_methods_supported.includes("S256")) {
    throw new McpError("This server's sign-in doesn't support the secure (PKCE S256) flow My Graph uses.", "oauth");
  }
  const resource = prm?.resource ? canonicalResource(prm.resource) : canonicalResource(serverUrl);
  if (canonicalResource(serverUrl) !== resource && !canonicalResource(serverUrl).startsWith(resource)) {
    throw new McpError("The server's metadata names another address as itself.", "oauth");
  }
  return { resource, issuer: meta.issuer ?? issuer, meta, scopes: prm?.scopes_supported ?? meta.scopes_supported ?? [] };
}

export type Registration = { clientId: string; clientSecret: string | null };

/** Register My Graph as a public client (no secret, PKCE). */
export async function register(transport: Transport, meta: AuthServerMeta, redirectUri: string, clientName = "My Graph"): Promise<Registration> {
  if (!meta.registration_endpoint) throw new McpError("This server doesn't let apps register themselves. Use an API key instead.", "oauth");
  const res = await transport({
    url: meta.registration_endpoint, method: "POST", timeoutMs: 15_000, maxBytes: 64 * 1024,
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: clientName, redirect_uris: [redirectUri], token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
    }),
  });
  const b = json(res) as { client_id?: string; client_secret?: string; error_description?: string; error?: string } | null;
  if (res.status < 200 || res.status >= 300 || !b?.client_id) {
    throw new McpError(`The server didn't register My Graph: ${b?.error_description ?? b?.error ?? `HTTP ${res.status}`}.`, "oauth");
  }
  return { clientId: b.client_id, clientSecret: typeof b.client_secret === "string" ? b.client_secret : null };
}

async function tokenRequest(transport: Transport, endpoint: string, form: Record<string, string>, reg: Registration): Promise<Tokens> {
  const body = new URLSearchParams({ ...form, client_id: reg.clientId, ...(reg.clientSecret ? { client_secret: reg.clientSecret } : {}) });
  const res = await transport({
    url: endpoint, method: "POST", timeoutMs: 15_000, maxBytes: 64 * 1024,
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: body.toString(),
  });
  const b = json(res) as { error?: string; error_description?: string } | null;
  if (res.status < 200 || res.status >= 300) {
    const why = b?.error_description ?? b?.error ?? `HTTP ${res.status}`;
    throw new McpError(b?.error === "invalid_grant" ? "The sign-in has ended. Sign in again." : `The sign-in was refused: ${why}.`, "oauth", { status: res.status });
  }
  return tokensFrom(b);
}

export function exchangeCode(transport: Transport, meta: Pick<AuthServerMeta, "token_endpoint">, reg: Registration, p: { code: string; verifier: string; redirectUri: string; resource: string }): Promise<Tokens> {
  return tokenRequest(transport, meta.token_endpoint, { grant_type: "authorization_code", code: p.code, code_verifier: p.verifier, redirect_uri: p.redirectUri, resource: p.resource }, reg);
}

export async function refreshTokens(transport: Transport, tokenEndpoint: string, reg: Registration, refreshToken: string, resource: string): Promise<Tokens> {
  const t = await tokenRequest(transport, tokenEndpoint, { grant_type: "refresh_token", refresh_token: refreshToken, resource }, reg);
  // A server that doesn't rotate keeps the old refresh token working.
  return { ...t, refreshToken: t.refreshToken ?? refreshToken };
}
