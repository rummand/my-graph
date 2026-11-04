/**
 * My Graph as its own OAuth 2.1 authorization server for its MCP server, as the MCP authorization specification
 * (2025-11-25, and 2025-06-18 before it) asks, after Record's: protected resource metadata (RFC 9728), authorization
 * server metadata (RFC 8414), dynamic client registration (RFC 7591), the authorization code flow with PKCE (S256
 * only), the `resource` parameter (RFC 8707) bound into every token, short-lived access tokens, refresh tokens rotated
 * on every use (a spent one coming back ends the whole connection), and revocation (RFC 7009).
 *
 * What a person allows is ONE graph and a scope: `read`, or `propose` (read, and propose changes that land as a change
 * set they deliver in My Graph). A token acts as its person, never beyond them, in that graph only, and only on the MCP
 * server. Codes and tokens are kept as hashes. No Next.js here: the routes and the consent page are thin around it.
 */
import { CLIENT_PREFIX, ACCESS_PREFIX, CODE_PREFIX, REFRESH_PREFIX, SECRET_PREFIX, challengeOk, hashToken, isOAuthToken, random, sameHash, verifierMatches } from "./tokens";
import { AUTH_METHODS, SCOPES, type AuthMethod, type ClientRow, type Credential, type GrantRow, type McpStore, type Scope } from "./types";

/** An access token lasts an hour; a refresh token 30 days from its last use; a code ten minutes, once. */
export const ACCESS_SECONDS = 3600, REFRESH_DAYS = 30, CODE_SECONDS = 600;

/* ── Addresses and metadata ─────────────────────────────────────────────────────────────────────────────── */

export const mcpResource = (origin: string) => `${origin}/api/mcp`;
export const resourceMetadataUrl = (origin: string) => `${origin}/.well-known/oauth-protected-resource/api/mcp`;
export const CONSENT_PATH = "/settings/ai-apps/allow";

/** A URI in canonical form (RFC 8707): lower-case scheme and host, no fragment, no trailing slash. */
export function canonical(uri: string): string | null {
  try {
    const u = new URL(uri);
    if (u.hash || (u.protocol !== "https:" && u.protocol !== "http:")) return null;
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return null;
  }
}

/** The resource a request names, when it is this MCP server; left out means this server, the only one here. */
export function resourceFor(origin: string, asked: string | null | undefined): string | null {
  const mine = mcpResource(origin);
  if (!asked) return mine;
  return canonical(asked) === canonical(mine) ? mine : null;
}

export const protectedResourceMetadata = (origin: string) => ({
  resource: mcpResource(origin),
  authorization_servers: [origin],
  scopes_supported: SCOPES,
  bearer_methods_supported: ["header"],
  resource_name: "My Graph",
  resource_documentation: `${origin}/settings/ai-apps`,
});

export const authorizationServerMetadata = (origin: string) => ({
  issuer: origin,
  authorization_endpoint: `${origin}${CONSENT_PATH}`,
  token_endpoint: `${origin}/api/mcp/oauth/token`,
  registration_endpoint: `${origin}/api/mcp/oauth/register`,
  revocation_endpoint: `${origin}/api/mcp/oauth/revoke`,
  scopes_supported: SCOPES,
  response_types_supported: ["code"],
  response_modes_supported: ["query"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: AUTH_METHODS,
  revocation_endpoint_auth_methods_supported: AUTH_METHODS,
  authorization_response_iss_parameter_supported: true,
  service_documentation: `${origin}/settings/ai-apps`,
});

/** The challenge a 401 from the MCP server carries, so a client finds where to sign in. */
export function challenge(origin: string, error?: "invalid_token"): string {
  return `Bearer realm="My Graph", resource_metadata="${resourceMetadataUrl(origin)}", scope="${SCOPES.join(" ")}"${error ? `, error="${error}"` : ""}`;
}

/* ── Dynamic client registration (RFC 7591) ─────────────────────────────────────────────────────────────── */

/** A redirect address an app may use: https, or http on this computer (a desktop client); never with a fragment. */
export function redirectAllowed(uri: unknown): uri is string {
  if (typeof uri !== "string" || uri.length > 500) return false;
  try {
    const u = new URL(uri);
    if (u.hash || u.username || u.password) return false;
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

export const REGISTRATIONS_PER_HOUR = 30;
const registrations = new Map<string, { start: number; n: number }>();
export function registrationLimited(ip: string, now = Date.now()): boolean {
  const w = registrations.get(ip);
  if (!w || now - w.start >= 3_600_000) {
    registrations.set(ip, { start: now, n: 1 });
    if (registrations.size > 10_000) for (const [k, v] of registrations) if (now - v.start >= 3_600_000) registrations.delete(k);
    return false;
  }
  return ++w.n > REGISTRATIONS_PER_HOUR;
}

export type Answer = { status: number; body: Record<string, unknown> | null; headers?: Record<string, string> };
const oauthError = (status: number, error: string, description: string, headers?: Record<string, string>): Answer => ({ status, body: { error, error_description: description }, headers });

export async function registerClient(store: McpStore, input: unknown, ip = ""): Promise<Answer> {
  if (registrationLimited(ip || "unknown")) return oauthError(429, "slow_down", "Too many apps registered from here. Try again in an hour.");
  const m = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const uris = m.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.length > 10) return oauthError(400, "invalid_redirect_uri", "Give one to ten redirect_uris.");
  if (!uris.every(redirectAllowed)) return oauthError(400, "invalid_redirect_uri", "Each redirect URI is https, or http on localhost, with no fragment.");
  const method = (m.token_endpoint_auth_method ?? "client_secret_basic") as AuthMethod;
  if (!AUTH_METHODS.includes(method)) return oauthError(400, "invalid_client_metadata", `token_endpoint_auth_method is one of ${AUTH_METHODS.join(", ")}.`);
  const grants = m.grant_types ?? ["authorization_code"];
  if (!Array.isArray(grants) || !grants.every((g) => g === "authorization_code" || g === "refresh_token")) return oauthError(400, "invalid_client_metadata", "grant_types are authorization_code and refresh_token.");
  const responses = m.response_types ?? ["code"];
  if (!Array.isArray(responses) || !responses.every((r) => r === "code")) return oauthError(400, "invalid_client_metadata", "response_types is code.");
  const uri = typeof m.client_uri === "string" && redirectAllowed(m.client_uri) ? m.client_uri : null;
  const name = (typeof m.client_name === "string" ? m.client_name.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) : "")
    || (uri ? new URL(uri).host : "") || "An app without a name";
  const secret = method === "none" ? null : random(SECRET_PREFIX);
  const row: ClientRow = { id: random(CLIENT_PREFIX, 16), name, uri, redirectUris: uris as string[], authMethod: method, secretHash: secret ? hashToken(secret) : null, createdAt: new Date() };
  await store.insertClient(row);
  return {
    status: 201,
    body: {
      client_id: row.id, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: name, ...(uri ? { client_uri: uri } : {}), redirect_uris: row.redirectUris,
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: method,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    },
  };
}

/* ── The authorization request and the person's answer ──────────────────────────────────────────────────── */

export const PARAMS = ["client_id", "redirect_uri", "response_type", "state", "code_challenge", "code_challenge_method", "resource", "scope"] as const;
export type Params = Partial<Record<(typeof PARAMS)[number], string>>;

export type AuthRequest = {
  client: ClientRow; redirectUri: string; state: string; challenge: string; resource: string;
  /** What the person may choose from: what the app asked for (both, when it named none). */
  offered: Scope[];
};

/** Until the app and its redirect are known, a problem is shown to the person (`show`); after, the app is told. */
export type Checked = { ok: true; req: AuthRequest } | { ok: false; show: string } | { ok: false; redirect: string };

function back(redirectUri: string, origin: string, values: Record<string, string>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(values)) if (v) u.searchParams.set(k, v);
  u.searchParams.set("iss", origin);
  return u.toString();
}

export function paramsOf(input: URLSearchParams | Record<string, string | string[] | undefined>): Params {
  const p: Params = {};
  for (const k of PARAMS) {
    const v = input instanceof URLSearchParams ? input.get(k) : input[k];
    const s = Array.isArray(v) ? v[0] : v;
    if (typeof s === "string" && s) p[k] = s.slice(0, 2000);
  }
  return p;
}

export async function checkAuthorize(store: McpStore, origin: string, p: Params): Promise<Checked> {
  const client = p.client_id ? await store.client(p.client_id) : null;
  if (!client) return { ok: false, show: "unknownApp" };
  const redirectUri = p.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : "");
  if (!client.redirectUris.includes(redirectUri)) return { ok: false, show: "badRedirect" };
  const state = (p.state ?? "").slice(0, 500);
  const fail = (error: string, description: string): Checked => ({ ok: false, redirect: back(redirectUri, origin, { error, error_description: description, state }) });
  if (p.response_type !== "code") return fail("unsupported_response_type", "response_type is code.");
  if (!challengeOk(p.code_challenge)) return fail("invalid_request", "PKCE is needed: a code_challenge.");
  if (p.code_challenge_method !== "S256") return fail("invalid_request", "code_challenge_method is S256.");
  const resource = resourceFor(origin, p.resource);
  if (!resource) return fail("invalid_target", `The resource is ${mcpResource(origin)}.`);
  const asked = (p.scope ?? "").split(/\s+/).filter(Boolean);
  if (asked.some((x) => !SCOPES.includes(x as Scope))) return fail("invalid_scope", `The scopes are ${SCOPES.join(" and ")}.`);
  const offered: Scope[] = !asked.length || asked.includes("propose") ? ["read", "propose"] : ["read"];
  return { ok: true, req: { client, redirectUri, state, challenge: p.code_challenge!, resource, offered } };
}

export const hostOf = (uri: string) => { try { return new URL(uri).host; } catch { return uri; } };
/** The app returns to this computer (a desktop client such as Claude Code): said on the consent page. */
export const isLocalRedirect = (uri: string) => { try { return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(uri).hostname); } catch { return false; } };

export type Choice = { allow: boolean; scope?: unknown; graphId?: unknown };

export function consentOf(form: FormData): { p: Params; choice: Choice } {
  const p: Params = {};
  for (const k of PARAMS) { const v = form.get(k); if (typeof v === "string" && v) p[k] = v.slice(0, 2000); }
  return { p, choice: { allow: form.get("decision") === "allow", scope: form.get("access"), graphId: form.get("graph") } };
}

export type Approved = { redirect: string; allowed?: { client: ClientRow; scope: Scope; graphId: string; graphName: string } } | { show: string };

/**
 * The person's answer: a code for the app on its redirect address, or `access_denied`. The graph must be one the person
 * is in now; `propose` needs the scope offered and the person's right to write in that graph.
 */
export async function approve(store: McpStore, userId: string, origin: string, p: Params, choice: Choice, now = new Date()): Promise<Approved> {
  const c = await checkAuthorize(store, origin, p);
  if (!c.ok) return "show" in c ? { show: c.show } : { redirect: c.redirect };
  const { req } = c;
  if (!choice.allow) return { redirect: back(req.redirectUri, origin, { error: "access_denied", error_description: "The person said no.", state: req.state }) };
  const scope: Scope = choice.scope === "propose" ? "propose" : "read";
  if (!req.offered.includes(scope)) return { show: "onlyRead" };
  const graphId = typeof choice.graphId === "string" ? choice.graphId : "";
  if (!(await store.userActive(userId))) return { show: "inactive" };
  const access = graphId ? await store.graphAccess(userId, graphId) : null;
  if (!access) return { show: "pickGraph" };
  if (scope === "propose" && !access.canWrite) return { show: "cantWrite" };
  await store.sweepCodes(new Date(now.getTime() - 3_600_000)).catch(() => undefined);
  const code = random(CODE_PREFIX);
  await store.insertCode({
    codeHash: hashToken(code), clientId: req.client.id, userId, graphId, scope, resource: req.resource, redirectUri: req.redirectUri,
    challenge: req.challenge, expiresAt: new Date(now.getTime() + CODE_SECONDS * 1000), usedAt: null, grantId: null,
  });
  return { redirect: back(req.redirectUri, origin, { code, state: req.state }), allowed: { client: req.client, scope, graphId, graphName: access.name } };
}

/* ── The token endpoint ──────────────────────────────────────────────────────────────────────────────────── */

/** A request's form fields (OAuth sends them form-encoded; JSON is taken too). */
export async function formOf(request: Request): Promise<Record<string, string>> {
  const text = await request.text().catch(() => "");
  if (text.length > 20_000) return {};
  if ((request.headers.get("content-type") ?? "").includes("json")) {
    try {
      const v = JSON.parse(text) as unknown;
      return v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === "string")) as Record<string, string> : {};
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

async function clientOf(store: McpStore, authorization: string | null, f: Record<string, string>): Promise<ClientRow | Answer> {
  let clientId = f.client_id ?? "", secret = f.client_secret ?? "", basic = false;
  const m = authorization?.match(/^Basic\s+(.+)$/i);
  if (m) {
    const [u, pw] = Buffer.from(m[1], "base64").toString("utf8").split(":");
    const dec = (v: string | undefined) => { try { return decodeURIComponent((v ?? "").replace(/\+/g, " ")); } catch { return ""; } };
    clientId = dec(u); secret = dec(pw); basic = true;
  }
  const no = oauthError(401, "invalid_client", "My Graph does not know this app, or its secret is wrong.", basic ? { "www-authenticate": 'Basic realm="My Graph"' } : undefined);
  if (!clientId) return no;
  const c = await store.client(clientId);
  if (!c) return no;
  if (c.secretHash && (!secret || !sameHash(hashToken(secret), c.secretHash))) return no;
  return c;
}

const isAnswer = (x: ClientRow | Answer): x is Answer => "status" in x;

async function issue(store: McpStore, grant: GrantRow, now = Date.now()): Promise<Answer> {
  const access = random(ACCESS_PREFIX), refresh = random(REFRESH_PREFIX);
  await store.insertTokens([
    { id: random("mat_", 12), grantId: grant.id, kind: "access", tokenHash: hashToken(access), expiresAt: new Date(now + ACCESS_SECONDS * 1000), revokedAt: null },
    { id: random("mrt_", 12), grantId: grant.id, kind: "refresh", tokenHash: hashToken(refresh), expiresAt: new Date(now + REFRESH_DAYS * 86_400_000), revokedAt: null },
  ]);
  return { status: 200, body: { access_token: access, token_type: "Bearer", expires_in: ACCESS_SECONDS, refresh_token: refresh, scope: grant.scope === "propose" ? "read propose" : "read" } };
}

/** What the token endpoint did that the audit log keeps: a connection ended because a spent secret came back. */
export type TokenEvent = { reused?: { grantId: string; userId: string; graphId: string; client: string; what: "code" | "refresh token" }; connected?: { grant: GrantRow; client: string } };

export async function token(store: McpStore, request: Request, origin: string, events: TokenEvent = {}, now = new Date()): Promise<Answer> {
  const f = await formOf(request);
  const client = await clientOf(store, request.headers.get("authorization"), f);
  if (isAnswer(client)) return client;
  const asked = f.resource ? canonical(f.resource) : null;
  if (f.resource && !asked) return oauthError(400, "invalid_target", `The resource is ${mcpResource(origin)}.`);

  if (f.grant_type === "authorization_code") {
    const code = f.code ?? "";
    if (!code.startsWith(CODE_PREFIX)) return oauthError(400, "invalid_grant", "That code is not one My Graph gave.");
    const row = await store.code(hashToken(code));
    if (!row || row.clientId !== client.id) return oauthError(400, "invalid_grant", "That code is not one My Graph gave this app.");
    if (row.usedAt) {
      // A code used twice: whoever has it is not to be trusted, so what the first use made stops too (OAuth 2.1 4.1.3).
      if (row.grantId) {
        await store.endGrant(row.grantId, now);
        events.reused = { grantId: row.grantId, userId: row.userId, graphId: row.graphId, client: client.name, what: "code" };
      }
      return oauthError(400, "invalid_grant", "That code has been used.");
    }
    if (row.expiresAt <= now) return oauthError(400, "invalid_grant", "That code has expired. Connect again.");
    if ((f.redirect_uri ?? "") !== row.redirectUri) return oauthError(400, "invalid_grant", "redirect_uri is not the one the code was given for.");
    if (!verifierMatches(f.code_verifier ?? "", row.challenge)) return oauthError(400, "invalid_grant", "The code_verifier does not match the code_challenge.");
    if (asked && asked !== canonical(row.resource)) return oauthError(400, "invalid_target", "The resource is not the one the code was given for.");
    const grantId = random("mgg_", 16);
    if (!(await store.spendCode(row.codeHash, grantId, now))) return oauthError(400, "invalid_grant", "That code has been used.");
    if (!(await store.userActive(row.userId)) || !(await store.graphAccess(row.userId, row.graphId))) return oauthError(400, "invalid_grant", "This account can't use that graph any more.");
    // Connecting the same app again replaces what it had: one connection an app, listed once.
    for (const g of await store.liveGrants(row.userId, client.id)) await store.endGrant(g.id, now);
    const grant: GrantRow = { id: grantId, userId: row.userId, clientId: client.id, graphId: row.graphId, scope: row.scope, resource: row.resource, createdAt: now, lastUsedAt: null, revokedAt: null };
    await store.insertGrant(grant);
    events.connected = { grant, client: client.name };
    return issue(store, grant, now.getTime());
  }

  if (f.grant_type === "refresh_token") {
    const refresh = f.refresh_token ?? "";
    if (!refresh.startsWith(REFRESH_PREFIX)) return oauthError(400, "invalid_grant", "That refresh token is not one My Graph gave.");
    const t = await store.tokenByHash(hashToken(refresh));
    const g = t && t.kind === "refresh" ? await store.grant(t.grantId) : null;
    if (!t || !g || g.clientId !== client.id) return oauthError(400, "invalid_grant", "That refresh token is not one My Graph gave this app.");
    if (g.revokedAt) return oauthError(400, "invalid_grant", "This connection was ended. Connect again.");
    const reuse = async () => {
      // A spent refresh token back again: it was copied, so the whole connection stops (OAuth 2.1 4.3.1).
      await store.endGrant(g.id, now);
      events.reused = { grantId: g.id, userId: g.userId, graphId: g.graphId, client: client.name, what: "refresh token" };
      return oauthError(400, "invalid_grant", "That refresh token has been used. Connect again.");
    };
    if (t.revokedAt) return reuse();
    if (t.expiresAt <= now) return oauthError(400, "invalid_grant", "That refresh token has expired. Connect again.");
    if (asked && asked !== canonical(g.resource)) return oauthError(400, "invalid_target", "The resource is not the one this connection is for.");
    const want = (f.scope ?? "").split(/\s+/).filter(Boolean);
    if (want.some((x) => !SCOPES.includes(x as Scope) || (x === "propose" && g.scope !== "propose"))) return oauthError(400, "invalid_scope", "A refresh cannot widen what the person allowed.");
    if (!(await store.userActive(g.userId)) || !(await store.graphAccess(g.userId, g.graphId))) return oauthError(400, "invalid_grant", "This account can't use that graph any more.");
    if (!(await store.spendToken(t.id, now))) return reuse();
    return issue(store, g, now.getTime());
  }

  return oauthError(400, "unsupported_grant_type", "grant_type is authorization_code or refresh_token.");
}

/**
 * RFC 7009: an app ends a token of its own. A refresh token ends its whole connection; an access token, itself. Unknown
 * tokens are answered as known ones are, so nothing is learnt by asking.
 */
export async function revokeToken(store: McpStore, request: Request, now = new Date()): Promise<{ answer: Answer; ended?: { grant: GrantRow; client: ClientRow } }> {
  const f = await formOf(request);
  const client = await clientOf(store, request.headers.get("authorization"), f);
  if (isAnswer(client)) return { answer: client };
  const t = f.token ?? "";
  const ok: Answer = { status: 200, body: {} };
  if (!isOAuthToken(t)) return { answer: ok };
  const row = await store.tokenByHash(hashToken(t));
  const g = row ? await store.grant(row.grantId) : null;
  if (!row || !g || g.clientId !== client.id) return { answer: ok };
  if (row.kind === "refresh") {
    const live = !g.revokedAt;
    await store.endGrant(g.id, now);
    return { answer: ok, ...(live ? { ended: { grant: g, client } } : {}) };
  }
  await store.spendToken(row.id, now);
  return { answer: ok };
}

/* ── The MCP server's side: a bearer token, checked ──────────────────────────────────────────────────────── */

const TOUCH_MS = 60_000;

/**
 * The credential an access token stands for, while the token lasts, its connection is not ended, the person may still
 * use My Graph and is still in the graph, and the token was given for this resource. Anything else is nobody.
 */
export async function credentialForAccessToken(store: McpStore, tokenValue: string, resource: string, now = new Date()): Promise<Credential | null> {
  if (!tokenValue.startsWith(ACCESS_PREFIX) || tokenValue.length > 200) return null;
  const t = await store.tokenByHash(hashToken(tokenValue));
  if (!t || t.kind !== "access" || t.revokedAt || t.expiresAt <= now) return null;
  const g = await store.grant(t.grantId);
  if (!g || g.revokedAt || canonical(g.resource) !== canonical(resource)) return null;
  if (!(await store.userActive(g.userId))) return null;
  const client = await store.client(g.clientId);
  if (!g.lastUsedAt || now.getTime() - g.lastUsedAt.getTime() > TOUCH_MS) await store.touchGrant(g.id, now).catch(() => undefined);
  return { kind: "app", id: g.id, name: client?.name ?? "An app", userId: g.userId, graphId: g.graphId, scope: g.scope };
}

/* ── Connected apps, on the person's page ────────────────────────────────────────────────────────────────── */

export type ConnectedApp = { id: string; app: string; returnsTo: string; scope: Scope; graphId: string; createdAt: string; lastUsedAt: string | null };

export async function connectedApps(store: McpStore, userId: string, now = new Date()): Promise<ConnectedApp[]> {
  const out: ConnectedApp[] = [];
  for (const g of await store.liveGrants(userId)) {
    if (!(await store.hasLiveToken(g.id, now))) continue;
    const c = await store.client(g.clientId);
    out.push({ id: g.id, app: c?.name ?? "An app", returnsTo: hostOf(c?.redirectUris[0] ?? ""), scope: g.scope, graphId: g.graphId, createdAt: g.createdAt.toISOString(), lastUsedAt: g.lastUsedAt?.toISOString() ?? null });
  }
  return out;
}

/** The person ends a connection: its tokens stop at once. The row stays, ended, for the record. */
export async function disconnectApp(store: McpStore, userId: string, grantId: string, now = new Date()): Promise<{ grant: GrantRow; app: string } | null> {
  const g = await store.grant(grantId);
  if (!g || g.userId !== userId || g.revokedAt) return null;
  await store.endGrant(g.id, now);
  return { grant: g, app: (await store.client(g.clientId))?.name ?? "An app" };
}
