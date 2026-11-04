import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { approve, authorizationServerMetadata, challenge, checkAuthorize, connectedApps, credentialForAccessToken, disconnectApp, mcpResource, protectedResourceMetadata, redirectAllowed, registerClient, revokeToken, token, type TokenEvent } from "./oauth";
import { memoryStore } from "./store-memory";
import { hashToken } from "./tokens";

const ORIGIN = "https://graph.example.dk";
const USER = "11111111-1111-4111-8111-111111111111";
const FAMILY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORK_READONLY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const verifier = "v".repeat(20) + "-verifier-of-enough-length-1234567890";
const pkce = createHash("sha256").update(verifier).digest("base64url");

function setup() {
  const store = memoryStore({ graphs: { [USER]: { [FAMILY]: { name: "Hansen family", canWrite: true }, [WORK_READONLY]: { name: "Work", canWrite: false } } } });
  return store;
}

async function register(store: ReturnType<typeof setup>, extra: Record<string, unknown> = {}) {
  const r = await registerClient(store, { client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "none", ...extra }, `ip-${Math.random()}`);
  expect(r.status).toBe(201);
  return r.body as { client_id: string; client_secret?: string };
}

const params = (clientId: string, extra: Record<string, string> = {}) => ({
  client_id: clientId, redirect_uri: "https://claude.ai/api/mcp/auth_callback", response_type: "code", state: "s-123",
  code_challenge: pkce, code_challenge_method: "S256", resource: `${ORIGIN}/api/mcp`, ...extra,
});

const form = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/api/mcp/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields) });

async function codeFor(store: ReturnType<typeof setup>, clientId: string, scope: "read" | "propose" = "read", graphId = FAMILY) {
  const a = await approve(store, USER, ORIGIN, params(clientId), { allow: true, scope, graphId });
  if (!("redirect" in a)) throw new Error(`no redirect: ${JSON.stringify(a)}`);
  const u = new URL(a.redirect);
  expect(u.searchParams.get("state")).toBe("s-123");
  expect(u.searchParams.get("iss")).toBe(ORIGIN);
  return u.searchParams.get("code")!;
}

describe("metadata", () => {
  it("describes the resource and the authorization server (RFC 9728, RFC 8414)", () => {
    expect(protectedResourceMetadata(ORIGIN)).toMatchObject({ resource: `${ORIGIN}/api/mcp`, authorization_servers: [ORIGIN], scopes_supported: ["read", "propose"] });
    const m = authorizationServerMetadata(ORIGIN);
    expect(m.code_challenge_methods_supported).toEqual(["S256"]);
    expect(m.registration_endpoint).toBe(`${ORIGIN}/api/mcp/oauth/register`);
    expect(challenge(ORIGIN, "invalid_token")).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/mcp"`);
  });
  it("only lets apps return to https or this computer", () => {
    expect(redirectAllowed("https://chatgpt.com/connector_platform_oauth_redirect")).toBe(true);
    expect(redirectAllowed("http://127.0.0.1:33418/callback")).toBe(true);
    expect(redirectAllowed("http://evil.example/cb")).toBe(false);
    expect(redirectAllowed("https://x.example/cb#frag")).toBe(false);
    expect(redirectAllowed("javascript:alert(1)")).toBe(false);
  });
});

describe("registration (RFC 7591)", () => {
  it("refuses bad redirects and odd grants; keeps a secret only as a hash", async () => {
    const store = setup();
    expect((await registerClient(store, { redirect_uris: ["http://evil.example/cb"] }, "a")).status).toBe(400);
    expect((await registerClient(store, { redirect_uris: ["https://ok.example/cb"], grant_types: ["password"] }, "a")).status).toBe(400);
    const c = await register(store, { token_endpoint_auth_method: "client_secret_basic" });
    expect(c.client_secret).toMatch(/^mgs_/);
    expect(store.tables.clients[0].secretHash).toBe(hashToken(c.client_secret!));
    expect(JSON.stringify(store.tables)).not.toContain(c.client_secret!);
  });
});

describe("the authorization request", () => {
  it("shows (never redirects) an unknown app or an unregistered redirect", async () => {
    const store = setup();
    const c = await register(store);
    expect(await checkAuthorize(store, ORIGIN, params("mgcl_nope"))).toEqual({ ok: false, show: "unknownApp" });
    expect(await checkAuthorize(store, ORIGIN, params(c.client_id, { redirect_uri: "https://attacker.example/cb" }))).toEqual({ ok: false, show: "badRedirect" });
  });
  it("sends other problems back to the app: no PKCE, plain PKCE, another resource, unknown scope", async () => {
    const store = setup();
    const c = await register(store);
    for (const bad of [{ code_challenge: "" }, { code_challenge_method: "plain" }, { resource: "https://other.example/api/mcp" }, { scope: "admin" }] as Record<string, string>[]) {
      const r = await checkAuthorize(store, ORIGIN, params(c.client_id, bad));
      expect(r.ok).toBe(false);
      expect("redirect" in r && new URL(r.redirect).searchParams.get("error")).toBeTruthy();
    }
  });
  it("offers propose only when the app asked for it (or named no scope)", async () => {
    const store = setup();
    const c = await register(store);
    const both = await checkAuthorize(store, ORIGIN, params(c.client_id));
    const read = await checkAuthorize(store, ORIGIN, params(c.client_id, { scope: "read" }));
    expect(both.ok && both.req.offered).toEqual(["read", "propose"]);
    expect(read.ok && read.req.offered).toEqual(["read"]);
    expect(await approve(store, USER, ORIGIN, params(c.client_id, { scope: "read" }), { allow: true, scope: "propose", graphId: FAMILY })).toEqual({ show: "onlyRead" });
  });
  it("binds ONE graph the person is in, and propose only where they may write", async () => {
    const store = setup();
    const c = await register(store);
    expect(await approve(store, USER, ORIGIN, params(c.client_id), { allow: true, scope: "read", graphId: OTHER })).toEqual({ show: "pickGraph" });
    expect(await approve(store, USER, ORIGIN, params(c.client_id), { allow: true, scope: "read" })).toEqual({ show: "pickGraph" });
    expect(await approve(store, USER, ORIGIN, params(c.client_id), { allow: true, scope: "propose", graphId: WORK_READONLY })).toEqual({ show: "cantWrite" });
    const denied = await approve(store, USER, ORIGIN, params(c.client_id), { allow: false });
    expect("redirect" in denied && new URL(denied.redirect).searchParams.get("error")).toBe("access_denied");
  });
});

describe("the token endpoint", () => {
  it("swaps a code for tokens once, with the right verifier; a code used twice ends the connection", async () => {
    const store = setup();
    const c = await register(store);
    const code = await codeFor(store, c.client_id, "propose");
    const base = { grant_type: "authorization_code", code, client_id: c.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", resource: `${ORIGIN}/api/mcp` };
    expect((await token(store, form({ ...base, code_verifier: "w".repeat(50) }), ORIGIN)).body).toMatchObject({ error: "invalid_grant" });
    expect((await token(store, form({ ...base, redirect_uri: "https://claude.ai/other", code_verifier: verifier }), ORIGIN)).body).toMatchObject({ error: "invalid_grant" });
    const ok = await token(store, form({ ...base, code_verifier: verifier }), ORIGIN);
    expect(ok.status).toBe(200);
    const body = ok.body as { access_token: string; refresh_token: string; scope: string };
    expect(body.access_token).toMatch(/^mga_/);
    expect(body.scope).toBe("read propose");
    const cred = await credentialForAccessToken(store, body.access_token, mcpResource(ORIGIN));
    expect(cred).toMatchObject({ kind: "app", userId: USER, graphId: FAMILY, scope: "propose", name: "Claude" });
    // Tokens are kept only as hashes.
    expect(JSON.stringify(store.tables)).not.toContain(body.access_token);
    expect(JSON.stringify(store.tables)).not.toContain(code);

    const events: TokenEvent = {};
    const again = await token(store, form({ ...base, code_verifier: verifier }), ORIGIN, events);
    expect(again.body).toMatchObject({ error: "invalid_grant" });
    expect(events.reused?.what).toBe("code");
    expect(await credentialForAccessToken(store, body.access_token, mcpResource(ORIGIN))).toBeNull();
  });

  it("an access token works only on this resource and only until it expires", async () => {
    const store = setup();
    const c = await register(store);
    const code = await codeFor(store, c.client_id);
    const ok = await token(store, form({ grant_type: "authorization_code", code, client_id: c.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_verifier: verifier }), ORIGIN);
    const { access_token } = ok.body as { access_token: string };
    expect(await credentialForAccessToken(store, access_token, "https://another.example/api/mcp")).toBeNull();
    expect(await credentialForAccessToken(store, access_token, mcpResource(ORIGIN), new Date(Date.now() + 2 * 3600_000))).toBeNull();
  });

  it("rotates refresh tokens; a spent one coming back ends the whole connection", async () => {
    const store = setup();
    const c = await register(store);
    const code = await codeFor(store, c.client_id);
    const first = (await token(store, form({ grant_type: "authorization_code", code, client_id: c.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_verifier: verifier }), ORIGIN)).body as { refresh_token: string; access_token: string };
    const second = await token(store, form({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: c.client_id }), ORIGIN);
    expect(second.status).toBe(200);
    const fresh = second.body as { access_token: string; refresh_token: string; scope: string };
    expect(fresh.scope).toBe("read");
    expect(await credentialForAccessToken(store, fresh.access_token, mcpResource(ORIGIN))).not.toBeNull();
    // A refresh can't widen a read connection.
    expect((await token(store, form({ grant_type: "refresh_token", refresh_token: fresh.refresh_token, client_id: c.client_id, scope: "propose" }), ORIGIN)).body).toMatchObject({ error: "invalid_scope" });
    const events: TokenEvent = {};
    const replay = await token(store, form({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: c.client_id }), ORIGIN, events);
    expect(replay.body).toMatchObject({ error: "invalid_grant" });
    expect(events.reused?.what).toBe("refresh token");
    expect(await credentialForAccessToken(store, fresh.access_token, mcpResource(ORIGIN))).toBeNull();
  });

  it("checks a confidential client's secret (Basic)", async () => {
    const store = setup();
    const c = await register(store, { token_endpoint_auth_method: "client_secret_basic" });
    const code = await codeFor(store, c.client_id);
    const fields = { grant_type: "authorization_code", code, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_verifier: verifier };
    const wrong = await token(store, form(fields, { authorization: `Basic ${Buffer.from(`${c.client_id}:nope`).toString("base64")}` }), ORIGIN);
    expect(wrong.status).toBe(401);
    const right = await token(store, form(fields, { authorization: `Basic ${Buffer.from(`${c.client_id}:${c.client_secret}`).toString("base64")}` }), ORIGIN);
    expect(right.status).toBe(200);
  });

  it("stops when the person left the graph or the account can't be used", async () => {
    const store = setup();
    const c = await register(store);
    const code = await codeFor(store, c.client_id);
    const { access_token, refresh_token } = (await token(store, form({ grant_type: "authorization_code", code, client_id: c.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_verifier: verifier }), ORIGIN)).body as Record<string, string>;
    const locked = { ...store, userActive: async () => false };
    expect(await credentialForAccessToken(locked, access_token, mcpResource(ORIGIN))).toBeNull();
    const gone = { ...store, graphAccess: async () => null };
    expect((await token(gone, form({ grant_type: "refresh_token", refresh_token, client_id: c.client_id }), ORIGIN)).body).toMatchObject({ error: "invalid_grant" });
  });
});

describe("connected apps", () => {
  it("lists, revokes (RFC 7009) and disconnects", async () => {
    const store = setup();
    const c = await register(store);
    const code = await codeFor(store, c.client_id);
    const t = (await token(store, form({ grant_type: "authorization_code", code, client_id: c.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_verifier: verifier }), ORIGIN)).body as Record<string, string>;
    const apps = await connectedApps(store, USER);
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({ app: "Claude", returnsTo: "claude.ai", graphId: FAMILY, scope: "read" });
    // Connecting the same app again replaces the earlier connection.
    const code2 = await codeFor(store, c.client_id);
    await token(store, form({ grant_type: "authorization_code", code: code2, client_id: c.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_verifier: verifier }), ORIGIN);
    expect(await connectedApps(store, USER)).toHaveLength(1);
    expect(await credentialForAccessToken(store, t.access_token, mcpResource(ORIGIN))).toBeNull();
    // Someone else can't disconnect it; the person can.
    const [live] = await connectedApps(store, USER);
    expect(await disconnectApp(store, "99999999-9999-4999-8999-999999999999", live.id)).toBeNull();
    expect(await disconnectApp(store, USER, live.id)).not.toBeNull();
    expect(await connectedApps(store, USER)).toHaveLength(0);
    // Revoking an unknown token still answers 200.
    const r = await revokeToken(store, form({ token: "mgr_unknown", client_id: c.client_id }));
    expect(r.answer.status).toBe(200);
  });
});
