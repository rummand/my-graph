import { describe, expect, it } from "vitest";
import type { HttpRequest, HttpResponse } from "@/lib/mcp-client/transport";
import { ConnectorError } from "../errors";
import { makeApi, isScopeProblem, retryAfter } from "./client";
import { apiBase, buildAuthorizeUrl, endpoint, isConfigured, isOAuthConnector, missingScope, pickerSettings, providerInfo, providerOf } from "./providers";
import { accessTokenFor, parseTokenAnswer, readTokens, tokenExpiring, writeTokens, type SecretStore } from "./tokens";

const env = { GOOGLE_CLIENT_ID: "123456789-abc.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "gsecret", MICROSOFT_CLIENT_ID: "ms-id", MICROSOFT_CLIENT_SECRET: "ms-secret", DROPBOX_APP_KEY: "dbx", DROPBOX_APP_SECRET: "dbxs", NODE_ENV: "test" };

const res = (status: number, json: unknown, headers: Record<string, string> = {}): HttpResponse => ({ status, headers, body: Buffer.from(JSON.stringify(json)), url: "" });

function memoryStore(initial: Record<string, string>): SecretStore & { saved: Record<string, string>[] } {
  let cur = { ...initial };
  const saved: Record<string, string>[] = [];
  return {
    saved,
    async load() { return { ...cur }; },
    async save(_id, s) { cur = { ...s }; saved.push({ ...s }); },
  };
}

describe("providers", () => {
  it("knows which connectors sign in where", () => {
    expect(providerOf("gmail")).toBe("google");
    expect(providerOf("microsoft")).toBe("microsoft");
    expect(providerOf("dropbox")).toBe("dropbox");
    expect(providerOf("imap")).toBeNull();
    expect(isOAuthConnector("google_drive")).toBe(true);
    expect(isOAuthConnector("toString")).toBe(false);
  });

  it("says what is missing when the household's app isn't set", () => {
    expect(providerInfo("google", {}).missing).toEqual(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);
    expect(isConfigured("google", env)).toBe(true);
    expect(providerInfo("dropbox", { DROPBOX_APP_KEY: "x" }).missing).toEqual(["DROPBOX_APP_SECRET"]);
  });

  it("uses the tenant for Microsoft and refuses odd characters in it", () => {
    expect(providerInfo("microsoft", { ...env, MICROSOFT_TENANT: "consumers" }).tokenUrl).toBe("https://login.microsoftonline.com/consumers/oauth2/v2.0/token");
    expect(providerInfo("microsoft", { ...env, MICROSOFT_TENANT: "../evil?x" }).tokenUrl).toBe("https://login.microsoftonline.com/..evilx/oauth2/v2.0/token");
    expect(providerInfo("microsoft", env).authorizeUrl).toContain("/common/");
  });

  it("builds the consent address with PKCE, state, offline access and the narrow scope", () => {
    const u = new URL(buildAuthorizeUrl(providerInfo("google", env), "gmail", { redirectUri: "https://mg.example/api/connections/oauth/callback", state: "s", challenge: "c", loginHint: "anna@gmail.com" }));
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      response_type: "code", client_id: env.GOOGLE_CLIENT_ID, state: "s", code_challenge: "c", code_challenge_method: "S256",
      access_type: "offline", prompt: "consent", login_hint: "anna@gmail.com",
      scope: "openid email https://www.googleapis.com/auth/gmail.readonly",
    });
    const d = new URL(buildAuthorizeUrl(providerInfo("dropbox", env), "dropbox", { redirectUri: "x", state: "s", challenge: "c" }));
    expect(d.searchParams.get("token_access_type")).toBe("offline");
    const m = new URL(buildAuthorizeUrl(providerInfo("microsoft", env), "microsoft", { redirectUri: "x", state: "s", challenge: "c" }));
    expect(m.searchParams.get("scope")).toContain("offline_access");
    expect(m.searchParams.get("scope")).toContain("Mail.Read");
  });

  it("points everything at a mock server outside production only", () => {
    const mock = { CONNECTORS_MOCK_BASE: "http://localhost:7801/", NODE_ENV: "development" };
    expect(endpoint("https://oauth2.googleapis.com/token", mock)).toBe("http://localhost:7801/oauth2.googleapis.com/token");
    expect(endpoint("https://oauth2.googleapis.com/token", { ...mock, NODE_ENV: "production" })).toBe("https://oauth2.googleapis.com/token");
    expect(apiBase(mock).graph).toBe("http://localhost:7801/graph.microsoft.com/v1.0");
  });

  it("notices a scope the person unticked on the consent page", () => {
    expect(missingScope("gmail", "openid https://www.googleapis.com/auth/userinfo.email")).toBe("https://www.googleapis.com/auth/gmail.readonly");
    expect(missingScope("gmail", "https://www.googleapis.com/auth/gmail.readonly openid")).toBeNull();
    expect(missingScope("microsoft", "https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Calendars.Read https://graph.microsoft.com/Files.Read offline_access")).toBeNull();
    expect(missingScope("microsoft", "Mail.Read Files.Read")).toBe("Calendars.Read");
    expect(missingScope("dropbox", null)).toBeNull();
  });

  it("finds the picker's app id in the client id", () => {
    expect(pickerSettings(env)).toBeNull();
    expect(pickerSettings({ ...env, GOOGLE_PICKER_API_KEY: "k" })).toEqual({ developerKey: "k", appId: "123456789" });
  });
});

describe("tokens", () => {
  it("reads the token answer", () => {
    const t = parseTokenAnswer({ access_token: "a", refresh_token: "r", expires_in: 3600, token_type: "Bearer", scope: "x" }, 1000);
    expect(t).toEqual({ accessToken: "a", refreshToken: "r", expiresAt: 1000 + 3_600_000, scope: "x" });
    expect(() => parseTokenAnswer({})).toThrow(/access token/);
    expect(() => parseTokenAnswer({ access_token: "a", token_type: "mac" })).toThrow(/Bearer/);
  });

  it("round-trips through the secrets and knows when a token is ending", () => {
    const s = writeTokens({ other: "x" }, { accessToken: "a", refreshToken: "r", expiresAt: 100_000, scope: null });
    expect(readTokens(s)).toMatchObject({ accessToken: "a", refreshToken: "r", expiresAt: 100_000 });
    expect(readTokens({})).toBeNull();
    expect(readTokens({ oauth: "{nope" })).toBeNull();
    expect(tokenExpiring({ accessToken: "a", expiresAt: 100_000 }, 30_000)).toBe(false);
    expect(tokenExpiring({ accessToken: "a", expiresAt: 100_000 }, 50_000)).toBe(true);
    expect(tokenExpiring({ accessToken: null, expiresAt: null })).toBe(true);
    expect(tokenExpiring({ accessToken: "a", expiresAt: null })).toBe(false);
  });

  const p = providerInfo("microsoft", env);

  it("uses a fresh token without refreshing", async () => {
    const secrets = writeTokens({}, { accessToken: "fresh", refreshToken: "r1", expiresAt: Date.now() + 3_600_000, scope: null });
    let calls = 0;
    const t = await accessTokenFor({ id: "c" }, secrets, p, async () => { calls++; return res(200, {}); }, memoryStore(secrets));
    expect(t).toBe("fresh");
    expect(calls).toBe(0);
  });

  it("refreshes an ending token, saves the rotated refresh token at once, and refreshes only once when asked twice", async () => {
    const secrets = writeTokens({}, { accessToken: "old", refreshToken: "r1", expiresAt: Date.now() - 1000, scope: null });
    const store = memoryStore(secrets);
    const seen: HttpRequest[] = [];
    const transport = async (req: HttpRequest) => {
      seen.push(req);
      await new Promise((r) => setTimeout(r, 10));
      return res(200, { access_token: "new", refresh_token: "r2", expires_in: 3600, token_type: "Bearer" });
    };
    const [a, b] = await Promise.all([
      accessTokenFor({ id: "c-rot" }, secrets, p, transport, store),
      accessTokenFor({ id: "c-rot" }, secrets, p, transport, store),
    ]);
    expect([a, b]).toEqual(["new", "new"]);
    expect(seen).toHaveLength(1);
    const form = new URLSearchParams(seen[0].body);
    expect(Object.fromEntries(form)).toMatchObject({ grant_type: "refresh_token", refresh_token: "r1", client_id: "ms-id", client_secret: "ms-secret" });
    expect(readTokens(store.saved[0])?.refreshToken).toBe("r2");
    expect(readTokens(secrets)?.accessToken).toBe("new");
  });

  it("keeps the old refresh token when the provider doesn't rotate", async () => {
    const secrets = writeTokens({}, { accessToken: "old", refreshToken: "keep", expiresAt: 1, scope: null });
    const store = memoryStore(secrets);
    await accessTokenFor({ id: "c-keep" }, secrets, providerInfo("google", env), async () => res(200, { access_token: "n", expires_in: 3599 }), store);
    expect(readTokens(store.saved[0])?.refreshToken).toBe("keep");
  });

  it("uses a token another request already refreshed instead of spending the refresh token again", async () => {
    const mine = writeTokens({}, { accessToken: "old", refreshToken: "r1", expiresAt: 1, scope: null });
    const store = memoryStore(writeTokens({}, { accessToken: "theirs", refreshToken: "r2", expiresAt: Date.now() + 3_600_000, scope: null }));
    let calls = 0;
    const t = await accessTokenFor({ id: "c-other" }, mine, p, async () => { calls++; return res(200, {}); }, store);
    expect(t).toBe("theirs");
    expect(calls).toBe(0);
  });

  it("asks the person to sign in again when the refresh is refused", async () => {
    const secrets = writeTokens({}, { accessToken: "old", refreshToken: "dead", expiresAt: 1, scope: null });
    const err = await accessTokenFor({ id: "c-dead" }, secrets, p, async () => res(400, { error: "invalid_grant" }), memoryStore(secrets)).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err).toMatchObject({ kind: "needs_you", code: "signInAgain" });
  });

  it("retries later when the sign-in server is down, and needs the person when the app is refused", async () => {
    const secrets = writeTokens({}, { accessToken: "old", refreshToken: "r", expiresAt: 1, scope: null });
    await expect(accessTokenFor({ id: "c-503" }, secrets, p, async () => res(503, {}), memoryStore(secrets))).rejects.toMatchObject({ kind: "retry" });
    await expect(accessTokenFor({ id: "c-client" }, secrets, p, async () => res(401, { error: "invalid_client" }), memoryStore(secrets))).rejects.toMatchObject({ kind: "needs_you" });
    await expect(accessTokenFor({ id: "c-none" }, {}, p, async () => res(200, {}), memoryStore({}))).rejects.toMatchObject({ code: "signIn" });
  });
});

describe("authorised calls", () => {
  const mk = (answers: HttpResponse[], refreshed: string[] = []) => {
    const sent: HttpRequest[] = [];
    let token = "t1";
    const api = makeApi({
      who: "Google",
      transport: async (req) => { sent.push(req); return answers.shift() ?? res(200, {}); },
      token: async () => token,
      refresh: async () => { token = "t2"; refreshed.push(token); return token; },
    });
    return { api, sent, refreshed };
  };

  it("sends the bearer token and refreshes once on a 401", async () => {
    const { api, sent, refreshed } = mk([res(401, {}), res(200, { ok: 1 })]);
    const r = await api({ url: "https://x/y" });
    expect(r.json()).toEqual({ ok: 1 });
    expect(sent.map((s) => s.headers?.authorization)).toEqual(["Bearer t1", "Bearer t2"]);
    expect(refreshed).toEqual(["t2"]);
    expect(sent[0].follow).toBe(0);
  });

  it("needs the person after a second 401, and for missing permissions", async () => {
    await expect(mk([res(401, {}), res(401, {})]).api({ url: "https://x" })).rejects.toMatchObject({ kind: "needs_you", code: "signInAgain" });
    await expect(mk([res(403, { error: { message: "Request had insufficient authentication scopes.", status: "PERMISSION_DENIED", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } })]).api({ url: "https://x" }))
      .rejects.toMatchObject({ kind: "needs_you", code: "scopeMissing" });
  });

  it("backs off on 429 and 5xx, and hands other answers to the caller", async () => {
    await expect(mk([res(429, {}, { "retry-after": "30" })]).api({ url: "https://x" })).rejects.toMatchObject({ kind: "retry", code: "rateLimited", message: expect.stringContaining("30 seconds") });
    await expect(mk([res(503, {})]).api({ url: "https://x" })).rejects.toMatchObject({ kind: "retry" });
    expect((await mk([res(410, {})]).api({ url: "https://x" })).status).toBe(410);
    expect((await mk([res(404, {})]).api({ url: "https://x" })).status).toBe(404);
  });

  it("doesn't send the token where it isn't wanted", async () => {
    const { api, sent } = mk([res(200, {})]);
    await api({ url: "https://download.example/f", noAuth: true });
    expect(sent[0].headers?.authorization).toBeUndefined();
  });

  it("reads Retry-After and scope problems", () => {
    expect(retryAfter({ "retry-after": "12" })).toBe(12);
    expect(retryAfter({})).toBeNull();
    expect(isScopeProblem('{"error":{"code":"ErrorAccessDenied"}}')).toBe(true);
    expect(isScopeProblem('{"error":"not yours"}')).toBe(false);
  });
});
