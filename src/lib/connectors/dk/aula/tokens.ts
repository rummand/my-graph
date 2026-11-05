/**
 * Aula's OAuth tokens (no DB). The parent's helper does the MitID sign-in at home and hands My Graph only the tokens;
 * from then on My Graph keeps them alive with the refresh-token grant against login.aula.dk (as aula-mcp's
 * refreshAccessToken does; MIT, see LICENSE-aula-mcp.txt). A refused refresh means the sign-in has ended: the
 * connection then says "Needs you: reconnect Aula" and nothing is retried until the parent signs in again. MitID is
 * never started from here.
 */
import { z } from "zod";
import type { Transport } from "@/lib/mcp-client/transport";
import { AulaError } from "./client";
import { AULA_OAUTH } from "./constants";

/** What is stored, encrypted, on the connection. expiresAt is epoch milliseconds as a string. */
export const aulaSecrets = z.object({
  accessToken: z.string().min(8).max(8000).optional(),
  refreshToken: z.string().min(8).max(8000).optional(),
  expiresAt: z.string().regex(/^\d{10,16}$/).optional(),
});
export type AulaSecrets = z.infer<typeof aulaSecrets>;

export type AulaTokenSet = { accessToken: string; refreshToken: string; expiresAt: number };

/** Refresh this long before the access token ends. */
export const REFRESH_SKEW_MS = 2 * 60_000;

export function tokensFrom(s: Record<string, string | undefined>): AulaTokenSet | null {
  if (!s.accessToken || !s.refreshToken) return null;
  const at = Number(s.expiresAt);
  return { accessToken: s.accessToken, refreshToken: s.refreshToken, expiresAt: Number.isFinite(at) && at > 0 ? at : 0 };
}

export function toSecrets(t: AulaTokenSet): Record<string, string> {
  return { accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: String(Math.round(t.expiresAt)) };
}

export function needsRefresh(t: Pick<AulaTokenSet, "expiresAt">, now = Date.now()): boolean {
  return !t.expiresAt || t.expiresAt - REFRESH_SKEW_MS <= now;
}

/** A token endpoint answer → tokens. Keeps the old refresh token when the server doesn't rotate it. */
export function parseTokenResponse(body: string, now = Date.now(), fallbackRefresh?: string): AulaTokenSet {
  let j: { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; token_type?: unknown };
  try {
    j = JSON.parse(body);
  } catch {
    throw new AulaError("Aula's sign-in answer wasn't JSON.", "auth");
  }
  if (typeof j.access_token !== "string" || !j.access_token) throw new AulaError("Aula's sign-in answer had no access token.", "auth");
  if (typeof j.token_type === "string" && j.token_type.toLowerCase() !== "bearer") throw new AulaError("Aula's sign-in answer had an unexpected token type.", "auth");
  const refresh = typeof j.refresh_token === "string" && j.refresh_token ? j.refresh_token : fallbackRefresh;
  if (!refresh) throw new AulaError("Aula's sign-in answer had no refresh token.", "auth");
  const expiresIn = Number(j.expires_in);
  return { accessToken: j.access_token, refreshToken: refresh, expiresAt: now + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000 };
}

/** The refresh-token grant. 400/401 from Aula = the sign-in has ended (needs the parent); anything else retries. */
export async function refreshTokens(transport: Transport, authBase: string, refreshToken: string, opts: { signal?: AbortSignal; now?: () => number } = {}): Promise<AulaTokenSet> {
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: AULA_OAUTH.clientId }).toString();
  let res;
  try {
    res = await transport({
      url: `${authBase.replace(/\/$/, "")}${AULA_OAUTH.tokenPath}`, method: "POST", body, signal: opts.signal, timeoutMs: 30_000, maxBytes: 256 * 1024,
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    });
  } catch (e) {
    throw new AulaError(e instanceof Error ? e.message : "Aula's sign-in server couldn't be reached.", "network");
  }
  if (res.status === 400 || res.status === 401 || res.status === 403) throw new AulaError("Aula ended the sign-in (the refresh was refused).", "auth", res.status);
  if (res.status !== 200) throw new AulaError(`Aula's sign-in server answered HTTP ${res.status}.`, "http", res.status);
  return parseTokenResponse(res.body.toString("utf8"), (opts.now ?? Date.now)(), refreshToken);
}
