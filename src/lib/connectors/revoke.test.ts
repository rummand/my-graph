import { describe, expect, it } from "vitest";
import type { HttpRequest, HttpResponse, Transport } from "@/lib/mcp-client/transport";
import { revokeConnection } from "./revoke";

const ENV = {
  NODE_ENV: "test",
  GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gsecret",
  DROPBOX_APP_KEY: "dkey", DROPBOX_APP_SECRET: "dsecret",
  MICROSOFT_CLIENT_ID: "mid", MICROSOFT_CLIENT_SECRET: "msecret",
};

type Handler = (req: HttpRequest) => { status: number; json?: unknown } | undefined;

function fake(handler: Handler): Transport & { calls: HttpRequest[] } {
  const calls: HttpRequest[] = [];
  const t = (async (req: HttpRequest): Promise<HttpResponse> => {
    calls.push(req);
    const a = handler(req) ?? { status: 404, json: { error: "not_found" } };
    return { status: a.status, headers: {}, body: Buffer.from(JSON.stringify(a.json ?? {})), url: req.url };
  }) as Transport & { calls: HttpRequest[] };
  t.calls = calls;
  return t;
}

const oauth = (o: Record<string, unknown>) => ({ oauth: JSON.stringify(o) });
const form = (req: HttpRequest) => Object.fromEntries(new URLSearchParams(req.body ?? ""));

describe("disconnect hands access back", () => {
  it("Google: revokes the refresh token at oauth2.googleapis.com/revoke", async () => {
    const t = fake((r) => (r.url === "https://oauth2.googleapis.com/revoke" ? { status: 200 } : undefined));
    const r = await revokeConnection({ connector: "gmail", label: "Gmail", config: {} }, oauth({ accessToken: "ya29.a", refreshToken: "1//refresh", expiresAt: Date.now() + 1e6 }), t, ENV);
    expect(r).toMatchObject({ status: "revoked", provider: "Google", code: "revoked" });
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].method).toBe("POST");
    expect(form(t.calls[0])).toEqual({ token: "1//refresh" });
  });

  it("Google: a token Google already forgot counts as revoked", async () => {
    const t = fake(() => ({ status: 400, json: { error: "invalid_token", error_description: "Token expired or revoked" } }));
    const r = await revokeConnection({ connector: "google_calendar", label: "Calendar", config: {} }, oauth({ accessToken: "ya29.a", refreshToken: null }), t, ENV);
    expect(r.status).toBe("revoked");
    expect(form(t.calls[0]).token).toBe("ya29.a");
  });

  it("Google: a failure is reported without the token in the message, with where to remove the app", async () => {
    const t = fake(() => ({ status: 503, json: { error: "unavailable", error_description: "backend error for 1//refresh-secret-value" } }));
    const r = await revokeConnection({ connector: "google_drive", label: "Drive", config: {} }, oauth({ refreshToken: "1//refresh-secret-value" }), t, ENV);
    expect(r.status).toBe("failed");
    expect(r.message).not.toContain("1//refresh-secret-value");
    expect(r.manageUrl).toBe("https://myaccount.google.com/connections");
  });

  it("Dropbox: revokes with the access token as Bearer", async () => {
    const t = fake((r) => (r.url === "https://api.dropboxapi.com/2/auth/token/revoke" ? { status: 200, json: null } : undefined));
    const r = await revokeConnection({ connector: "dropbox", label: "Dropbox", config: {} }, oauth({ accessToken: "sl.abc", refreshToken: "rt", expiresAt: Date.now() + 3_600_000 }), t, ENV);
    expect(r).toMatchObject({ status: "revoked", provider: "Dropbox" });
    expect(t.calls[0].headers?.authorization).toBe("Bearer sl.abc");
    expect(t.calls[0].body).toBeUndefined();
  });

  it("Dropbox: an expired access token is refreshed once, then revoked", async () => {
    const t = fake((r) => {
      if (r.url === "https://api.dropboxapi.com/oauth2/token") return { status: 200, json: { access_token: "sl.fresh", token_type: "bearer", expires_in: 14400 } };
      if (r.url.endsWith("/2/auth/token/revoke")) return { status: 200, json: null };
      return undefined;
    });
    const r = await revokeConnection({ connector: "dropbox", label: "Dropbox", config: {} }, oauth({ accessToken: "sl.old", refreshToken: "rt", expiresAt: Date.now() - 1000 }), t, ENV);
    expect(r.status).toBe("revoked");
    expect(t.calls.map((c) => c.url)).toEqual(["https://api.dropboxapi.com/oauth2/token", "https://api.dropboxapi.com/2/auth/token/revoke"]);
    expect(form(t.calls[0])).toMatchObject({ grant_type: "refresh_token", refresh_token: "rt", client_id: "dkey" });
    expect(t.calls[1].headers?.authorization).toBe("Bearer sl.fresh");
  });

  it("Microsoft: nothing to call; the tokens are dropped and the person is told where to remove the app", async () => {
    const t = fake(() => undefined);
    const r = await revokeConnection({ connector: "microsoft", label: "Outlook", config: {} }, oauth({ accessToken: "eyJ", refreshToken: "M.R3" }), t, ENV);
    expect(t.calls).toHaveLength(0);
    expect(r).toMatchObject({ status: "dropped", provider: "Microsoft", code: "microsoft" });
    expect(r.message).toContain("account.live.com/consent/Manage");
  });

  it("MCP server with a revocation endpoint (RFC 7009): refresh token first, then the access token, with the client id", async () => {
    const t = fake((r) => (r.url === "https://auth.example.com/revoke" ? { status: 200 } : undefined));
    const secrets = oauth({ issuer: "https://auth.example.com", tokenEndpoint: "https://auth.example.com/token", authorizationEndpoint: "x", revocationEndpoint: "https://auth.example.com/revoke", resource: "https://mcp.example.com", clientId: "cl1", clientSecret: "cs1", redirectUri: "x", accessToken: "at", refreshToken: "rt" });
    const r = await revokeConnection({ connector: "mcp", label: "Notes server", config: { authMode: "oauth", serverName: "Notes" } }, secrets, t, ENV);
    expect(r).toMatchObject({ status: "revoked", provider: "Notes" });
    expect(t.calls.map(form)).toEqual([
      { token: "rt", token_type_hint: "refresh_token", client_id: "cl1", client_secret: "cs1" },
      { token: "at", token_type_hint: "access_token", client_id: "cl1", client_secret: "cs1" },
    ]);
  });

  it("MCP server without one: dropped and said so; API-key connections have nothing to hand back", async () => {
    const t = fake(() => undefined);
    const secrets = oauth({ issuer: "i", tokenEndpoint: "t", authorizationEndpoint: "a", resource: "r", clientId: "c", redirectUri: "x", accessToken: "at" });
    expect((await revokeConnection({ connector: "mcp", label: "S", config: { authMode: "oauth" } }, secrets, t, ENV)).status).toBe("dropped");
    expect((await revokeConnection({ connector: "mcp", label: "S", config: { authMode: "key" } }, { apiKey: "k" }, t, ENV)).status).toBe("none");
    expect((await revokeConnection({ connector: "ics", label: "Calendar", config: {} }, { url: "https://x" }, t, ENV)).status).toBe("none");
    expect(t.calls).toHaveLength(0);
  });

  it("an unreachable provider never throws", async () => {
    const t = (async () => { throw new Error("ECONNRESET"); }) as unknown as Transport;
    const r = await revokeConnection({ connector: "gmail", label: "Gmail", config: {} }, oauth({ refreshToken: "rt" }), t, ENV);
    expect(r.status).toBe("failed");
  });
});
