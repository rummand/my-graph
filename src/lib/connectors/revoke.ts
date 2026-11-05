/**
 * Handing access back when a connection is disconnected (server-only, no DB: it takes the decrypted secrets and a
 * transport, so the tests run it against a fake provider).
 *
 *   Google      POST https://oauth2.googleapis.com/revoke  token=<refresh token, else access token>. Revoking the
 *               refresh token ends every access token made from it; Google also drops the app from the account.
 *   Dropbox     POST https://api.dropboxapi.com/2/auth/token/revoke with the access token as Bearer. It ends that
 *               token and its refresh token. An expired access token is refreshed once first, then revoked.
 *   Slack       POST https://slack.com/api/auth.revoke with the user token as Bearer.
 *   Notion      has no revoke endpoint for a public integration: the token is deleted and the person told where to finish.
 *   Microsoft   has no endpoint for an app to hand back one sign-in (revokeSignInSessions would sign the person out
 *               everywhere). My Graph deletes its tokens and tells the person where to remove the app's consent.
 *   MCP servers that advertise a revocation_endpoint (RFC 7009 / RFC 8414 metadata): the refresh token, then the access
 *               token, with token_type_hint, client_id (and client_secret when registered with one) in the body.
 *               A server without one: tokens dropped, and said so.
 *
 * Never throws: a failure to revoke is reported (and the tokens are still deleted with the connection). Nothing here
 * logs or returns a token; error text from the provider is cut short and the tokens are redacted from it.
 */
import type { HttpResponse, Transport } from "@/lib/mcp-client/transport";
import { redact } from "./crypto";
import { MCP_CONNECTORS } from "./registry";
import { readOAuth } from "./mcp/config";
import { providerInfo, providerOf, type Env, type ProviderInfo } from "./oauth/providers";
import { readTokens, tokenRequest } from "./oauth/tokens";

export type RevocationStatus =
  /** The provider confirmed (or said the token was already gone). */
  | "revoked"
  /** No way to revoke at the provider: the tokens were deleted here, and the person is told where to finish. */
  | "dropped"
  /** The provider couldn't be reached or refused; the tokens were deleted here anyway. */
  | "failed"
  /** Nothing to hand back (an ICS link, a mailbox password, no sign-in yet). */
  | "none";

export type Revocation = {
  status: RevocationStatus;
  /** Who it was handed back to ("Google", "Dropbox", "Microsoft", the MCP server's name). */
  provider: string | null;
  /** i18n code under security.revoke.* (the message below is the English of it). */
  code: "revoked" | "microsoft" | "noEndpoint" | "failed" | "failedWithUrl" | "none";
  /** Values for the i18n message: t(`security.revoke.${code}`, params). */
  params: Record<string, string>;
  message: string;
  /** Where the person can remove the app themselves (Microsoft, and any provider when revoking failed). */
  manageUrl?: string | null;
};

const TIMEOUT = 10_000;

export const MANAGE_URLS = {
  google: "https://myaccount.google.com/connections",
  microsoftPersonal: "https://account.live.com/consent/Manage",
  microsoftWork: "https://myapps.microsoft.com",
  dropbox: "https://www.dropbox.com/account/connected_apps",
  slack: "https://slack.com/apps/manage",
  notion: "https://www.notion.so/profile/integrations",
} as const;

const NONE: Revocation = { status: "none", provider: null, code: "none", params: {}, message: "There was no sign-in to hand back." };

function says(res: HttpResponse): string {
  try {
    const b = JSON.parse(res.body.toString("utf8")) as { error?: unknown; error_description?: unknown; error_summary?: unknown };
    return String(b.error_description ?? b.error_summary ?? b.error ?? `HTTP ${res.status}`);
  } catch {
    return `HTTP ${res.status}`;
  }
}

const ok = (who: string): Revocation => ({ status: "revoked", provider: who, code: "revoked", params: { provider: who }, message: `My Graph's access was handed back to ${who}.` });
const failed = (who: string, why: string, manageUrl: string | null, secrets: string[]): Revocation => ({
  status: "failed", provider: who, code: manageUrl ? "failedWithUrl" : "failed", manageUrl, params: { provider: who, ...(manageUrl ? { url: manageUrl } : {}) },
  message: `${who} couldn't be told (${redact(why, Object.fromEntries(secrets.map((s, i) => [String(i), s]))).slice(0, 160)}). My Graph deleted its sign-in anyway${manageUrl ? `; you can also remove My Graph at ${manageUrl}` : ""}.`,
});

async function post(transport: Transport, url: string, form: Record<string, string> | null, headers: Record<string, string> = {}): Promise<HttpResponse> {
  return transport({
    url, method: "POST", timeoutMs: TIMEOUT, maxBytes: 64 * 1024,
    body: form ? new URLSearchParams(form).toString() : undefined,
    headers: { accept: "application/json", ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}), ...headers },
  });
}

async function revokeGoogle(p: ProviderInfo, secrets: Record<string, string>, transport: Transport): Promise<Revocation> {
  const t = readTokens(secrets);
  const token = t?.refreshToken ?? t?.accessToken;
  if (!token || !p.revokeUrl) return NONE;
  const all = [t?.refreshToken, t?.accessToken].filter((x): x is string => !!x);
  try {
    const res = await post(transport, p.revokeUrl, { token });
    // 400 invalid_token: already revoked or expired at Google, which is what we wanted.
    if (res.status === 200 || (res.status === 400 && /invalid_token/.test(res.body.toString("utf8")))) return ok("Google");
    return failed("Google", says(res), MANAGE_URLS.google, all);
  } catch (e) {
    return failed("Google", e instanceof Error ? e.message : String(e), MANAGE_URLS.google, all);
  }
}

async function revokeDropbox(p: ProviderInfo, secrets: Record<string, string>, transport: Transport, now: number): Promise<Revocation> {
  const t = readTokens(secrets);
  if (!t?.accessToken && !t?.refreshToken) return NONE;
  if (!p.revokeUrl) return NONE;
  const all = [t.refreshToken, t.accessToken].filter((x): x is string => !!x);
  const call = (token: string) => post(transport, p.revokeUrl!, null, { authorization: `Bearer ${token}` });
  try {
    let access = t.accessToken && (t.expiresAt == null || t.expiresAt > now + 5_000) ? t.accessToken : null;
    let res = access ? await call(access) : null;
    // Expired (or no) access token: refresh once with the app's own credentials, then revoke the new one, which ends
    // the refresh token with it.
    if ((!res || res.status === 401) && t.refreshToken) {
      const fresh = await tokenRequest(transport, p, { grant_type: "refresh_token", refresh_token: t.refreshToken });
      access = fresh.accessToken;
      all.push(access);
      res = await call(access);
    }
    if (!res) return NONE;
    if (res.status === 200 || res.status === 401) return ok("Dropbox"); // 401 after a refresh: already gone
    return failed("Dropbox", says(res), MANAGE_URLS.dropbox, all);
  } catch (e) {
    // A refused refresh means the refresh token is already dead at Dropbox.
    if ((e as { code?: string }).code === "signInAgain") return ok("Dropbox");
    return failed("Dropbox", e instanceof Error ? e.message : String(e), MANAGE_URLS.dropbox, all);
  }
}

/** Slack: auth.revoke with the user token as Bearer (answers 200 + ok, or ok:false when it is already gone). */
async function revokeSlack(p: ProviderInfo, secrets: Record<string, string>, transport: Transport): Promise<Revocation> {
  const t = readTokens(secrets);
  if (!t?.accessToken || !p.revokeUrl) return NONE;
  const all = [t.refreshToken, t.accessToken].filter((x): x is string => !!x);
  try {
    const res = await post(transport, p.revokeUrl, null, { authorization: `Bearer ${t.accessToken}` });
    const body = res.body.toString("utf8");
    if (res.status === 200 && (/"ok"\s*:\s*true/.test(body) || /invalid_auth|token_revoked|token_expired|account_inactive/.test(body))) return ok("Slack");
    return failed("Slack", says(res), MANAGE_URLS.slack, all);
  } catch (e) {
    return failed("Slack", e instanceof Error ? e.message : String(e), MANAGE_URLS.slack, all);
  }
}

/** Notion has no endpoint for handing back an integration's token: it is deleted here, and the person told where to remove it. */
function dropNotion(secrets: Record<string, string>): Revocation {
  const t = readTokens(secrets);
  if (!t?.accessToken && !t?.refreshToken) return NONE;
  return {
    status: "dropped", provider: "Notion", code: "noEndpoint", params: { provider: "Notion" }, manageUrl: MANAGE_URLS.notion,
    message: `Notion has no way to hand access back, so My Graph deleted its sign-in. To end it at Notion too, open Settings, Connections in Notion and disconnect My Graph.`,
  };
}

function dropMicrosoft(secrets: Record<string, string>): Revocation {
  const t = readTokens(secrets);
  if (!t?.accessToken && !t?.refreshToken) return NONE;
  return {
    status: "dropped", provider: "Microsoft", code: "microsoft", manageUrl: MANAGE_URLS.microsoftPersonal,
    params: { personalUrl: MANAGE_URLS.microsoftPersonal, workUrl: MANAGE_URLS.microsoftWork },
    message: `Microsoft has no way for an app to hand back one sign-in, so My Graph deleted its tokens; they stop working within an hour. To remove My Graph from your Microsoft account too, open ${MANAGE_URLS.microsoftPersonal} (personal account) or ${MANAGE_URLS.microsoftWork} (work or school account).`,
  };
}

async function revokeMcp(label: string, secrets: Record<string, string>, transport: Transport): Promise<Revocation> {
  const o = readOAuth(secrets);
  if (!o || (!o.accessToken && !o.refreshToken)) return NONE;
  const who = label;
  if (!o.revocationEndpoint) {
    return { status: "dropped", provider: who, code: "noEndpoint", params: { provider: who }, message: `${who} has no way to hand access back, so My Graph deleted its sign-in. To end it at the server too, remove My Graph in that service's own settings.` };
  }
  const all = [o.refreshToken, o.accessToken].filter((x): x is string => !!x);
  const client = { client_id: o.clientId, ...(o.clientSecret ? { client_secret: o.clientSecret } : {}) };
  try {
    // RFC 7009 §2.1: refresh token first (a server that supports it ends the access tokens made from it too).
    const order: [string, string][] = [];
    if (o.refreshToken) order.push([o.refreshToken, "refresh_token"]);
    if (o.accessToken) order.push([o.accessToken, "access_token"]);
    for (const [token, hint] of order) {
      const res = await post(transport, o.revocationEndpoint, { token, token_type_hint: hint, ...client });
      // §2.2: 200 for success and for a token that is already invalid. 400 unsupported_token_type for an access token
      // the server can't revoke by itself is fine once the refresh token is gone.
      if (res.status === 200) continue;
      if (res.status === 400 && hint === "access_token" && order.length > 1 && /unsupported_token_type/.test(res.body.toString("utf8"))) continue;
      return failed(who, says(res), null, all);
    }
    return ok(who);
  } catch (e) {
    return failed(who, e instanceof Error ? e.message : String(e), null, all);
  }
}

/** Hand back the connection's access at its provider, as far as the provider allows. */
export async function revokeConnection(
  row: { connector: string; label: string; config: Record<string, unknown> | null },
  secrets: Record<string, string>,
  transport: Transport,
  env: Env = process.env,
  now = Date.now(),
): Promise<Revocation> {
  const provider = providerOf(row.connector);
  if (provider === "google") return revokeGoogle(providerInfo("google", env), secrets, transport);
  if (provider === "dropbox") return revokeDropbox(providerInfo("dropbox", env), secrets, transport, now);
  if (provider === "microsoft") return dropMicrosoft(secrets);
  if (provider === "slack") return revokeSlack(providerInfo("slack", env), secrets, transport);
  if (provider === "notion") return dropNotion(secrets);
  if (MCP_CONNECTORS.has(row.connector) && (row.config?.authMode ?? "key") === "oauth") {
    const name = typeof row.config?.serverName === "string" && row.config.serverName ? row.config.serverName : row.label;
    return revokeMcp(name, secrets, transport);
  }
  return NONE;
}
