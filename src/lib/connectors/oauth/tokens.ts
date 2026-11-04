/**
 * Tokens for the provider connectors (Google, Microsoft, Dropbox). They live in the connection's encrypted secrets
 * under `oauth` (JSON), never in config, never in a source, never in a log line and never sent to mux.
 *
 * Refresh: an access token is refreshed when it ends within a minute (or a provider answers 401). Microsoft and
 * sometimes Google rotate the refresh token: the new one is written back at once, encrypted. Refreshes of one
 * connection are serialised in this process (the run lease already keeps two runs apart; the options/picker routes can
 * overlap a run), and the newest saved tokens are re-read before each refresh, so a rotated token is never used twice.
 * A refused refresh (invalid_grant: revoked, password changed, 7-day testing-mode expiry at Google) is "needs you:
 * sign in again".
 */
import { needsYou, willRetry } from "../errors";
import type { HttpResponse, Transport } from "@/lib/mcp-client/transport";
import type { ProviderInfo } from "./providers";

export type TokenState = {
  accessToken: string | null;
  refreshToken: string | null;
  /** ms since epoch, or null when the provider didn't say. */
  expiresAt: number | null;
  scope: string | null;
  /** While a sign-in is under way: the state and PKCE verifier (kept encrypted, single use, 15 minutes). */
  pending?: { state: string; verifier: string; redirectUri: string; expiresAt: number; autoLabel?: boolean } | null;
  /** The address the code was traded with (a refresh never needs it; kept for the record). */
  redirectUri?: string | null;
};

export function readTokens(secrets: Record<string, string>): TokenState | null {
  if (!secrets.oauth) return null;
  try {
    const o = JSON.parse(secrets.oauth) as Partial<TokenState>;
    if (!o || typeof o !== "object") return null;
    return {
      accessToken: typeof o.accessToken === "string" ? o.accessToken : null,
      refreshToken: typeof o.refreshToken === "string" ? o.refreshToken : null,
      expiresAt: typeof o.expiresAt === "number" ? o.expiresAt : null,
      scope: typeof o.scope === "string" ? o.scope : null,
      pending: o.pending && typeof o.pending === "object" ? o.pending : null,
      redirectUri: typeof o.redirectUri === "string" ? o.redirectUri : null,
    };
  } catch {
    return null;
  }
}

export function writeTokens(secrets: Record<string, string>, t: TokenState): Record<string, string> {
  return { ...secrets, oauth: JSON.stringify(t) };
}

/** True when the access token is missing or ends within `marginMs`. */
export function tokenExpiring(t: Pick<TokenState, "accessToken" | "expiresAt">, now = Date.now(), marginMs = 60_000): boolean {
  if (!t.accessToken) return true;
  return t.expiresAt != null && t.expiresAt - marginMs <= now;
}

export const signInAgain = () => needsYou("The sign-in has ended. Sign in again to keep it connected.", "signInAgain");

export type TokenAnswer = { accessToken: string; refreshToken: string | null; expiresAt: number | null; scope: string | null };

/** Read a token endpoint's JSON answer (pure). Throws on an answer without an access token. */
export function parseTokenAnswer(body: unknown, now = Date.now()): TokenAnswer {
  const b = (body ?? {}) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown; token_type?: unknown };
  if (typeof b.access_token !== "string" || !b.access_token) throw new Error("The sign-in didn't give an access token.");
  if (typeof b.token_type === "string" && b.token_type.toLowerCase() !== "bearer") throw new Error(`The sign-in gave a "${b.token_type}" token; only Bearer tokens work.`);
  const secs = Number(b.expires_in);
  return {
    accessToken: b.access_token,
    refreshToken: typeof b.refresh_token === "string" && b.refresh_token ? b.refresh_token : null,
    expiresAt: Number.isFinite(secs) && secs > 0 ? now + secs * 1000 : null,
    scope: typeof b.scope === "string" ? b.scope : null,
  };
}

function jsonOf(res: HttpResponse): Record<string, unknown> | null {
  try { return JSON.parse(res.body.toString("utf8")) as Record<string, unknown>; } catch { return null; }
}

/** POST to the provider's token endpoint with the app's own client id and secret. */
export async function tokenRequest(transport: Transport, p: ProviderInfo, form: Record<string, string>, signal?: AbortSignal): Promise<TokenAnswer> {
  if (!p.clientId || !p.clientSecret) throw needsYou("This kind of connection isn't set up on this My Graph yet. Ask whoever runs it to add the app's client id and secret.", "providerNotSetUp");
  const body = new URLSearchParams({ ...form, client_id: p.clientId, client_secret: p.clientSecret }).toString();
  let res: HttpResponse;
  try {
    res = await transport({
      url: p.tokenUrl, method: "POST", body, timeoutMs: 20_000, maxBytes: 64 * 1024, signal,
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    });
  } catch (e) {
    throw willRetry(`Couldn't reach the sign-in server (${e instanceof Error ? e.message : String(e)}).`, "network");
  }
  const b = jsonOf(res);
  if (res.status >= 200 && res.status < 300) return parseTokenAnswer(b);
  const err = typeof b?.error === "string" ? b.error : "";
  if (res.status === 429 || res.status >= 500) throw willRetry("The sign-in server is busy. It will try again.", "serverError");
  if (err === "invalid_grant" || err === "invalid_token" || res.status === 401 || (res.status === 400 && form.grant_type === "refresh_token")) throw signInAgain();
  if (err === "invalid_client" || err === "unauthorized_client") throw needsYou("The provider refused My Graph's app (its client id or secret is wrong or expired). Whoever runs My Graph needs to check the app settings.", "providerRefused");
  const why = (typeof b?.error_description === "string" ? b.error_description : err || `HTTP ${res.status}`).slice(0, 200);
  throw needsYou(`The sign-in was refused: ${why}.`, "oauthRefused");
}

/** Where the saved secrets of a connection are read and written (the DB in the app, a map in the tests). */
export type SecretStore = {
  load(connectionId: string): Promise<Record<string, string> | null>;
  save(connectionId: string, secrets: Record<string, string>): Promise<void>;
};

const g = globalThis as unknown as { __mgOAuthRefresh?: Map<string, Promise<string>> };
const inflight = (g.__mgOAuthRefresh ??= new Map());

/**
 * The access token to use now, refreshed when it is ending (or when `force` is set, after a 401). `secrets` is updated
 * in place with whatever is saved, so the running sync keeps the newest tokens.
 */
export async function accessTokenFor(
  conn: { id: string }, secrets: Record<string, string>, p: ProviderInfo, transport: Transport, store: SecretStore,
  opts: { force?: boolean; now?: () => number; signal?: AbortSignal } = {},
): Promise<string> {
  const now = opts.now ?? Date.now;
  const t = readTokens(secrets);
  if (!t?.accessToken && !t?.refreshToken) throw needsYou("Sign in to connect it.", "signIn");
  if (!opts.force && t.accessToken && !tokenExpiring(t, now())) return t.accessToken;
  const running = inflight.get(conn.id);
  if (running) return running;
  const staleAccess = t.accessToken;
  const job = (async () => {
    // Another request in this process may have refreshed already: start from what is saved now.
    const saved = await store.load(conn.id);
    if (!saved) throw needsYou("This connection was disconnected.", "disconnected");
    const cur = readTokens(saved) ?? t;
    const fresh = cur.accessToken && !tokenExpiring(cur, now()) && (!opts.force || cur.accessToken !== staleAccess);
    if (fresh) {
      Object.assign(secrets, saved);
      return cur.accessToken!;
    }
    if (!cur.refreshToken) throw signInAgain();
    const a = await tokenRequest(transport, p, { grant_type: "refresh_token", refresh_token: cur.refreshToken }, opts.signal);
    // Rotation: a new refresh token replaces the old one at once; a provider that doesn't rotate keeps the old one working.
    const next: TokenState = { ...cur, accessToken: a.accessToken, refreshToken: a.refreshToken ?? cur.refreshToken, expiresAt: a.expiresAt, scope: a.scope ?? cur.scope, pending: null };
    const merged = writeTokens(saved, next);
    await store.save(conn.id, merged);
    Object.assign(secrets, merged);
    return a.accessToken;
  })().finally(() => inflight.delete(conn.id));
  inflight.set(conn.id, job);
  return job;
}
