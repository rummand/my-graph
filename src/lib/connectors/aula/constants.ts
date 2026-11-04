/**
 * Aula's sign-in and API addresses (pure).
 *
 * The OAuth client values are the ones Aula's own mobile app uses, as captured by aula-mcp
 * (github.com/Casperjuel/aula-mcp, packages/aula-auth/src/aula-oauth.ts, MIT, Copyright (c) 2026 Casper Juel; the
 * licence is in LICENSE-aula-mcp.txt next to this file). The API method names, the `access_token` query parameter, the
 * `/api/v{N}/` version that Aula bumps a few times a year (HTTP 410 on the old one) and the envelope sub-codes come from
 * aula-mcp's packages/aula-client and from nickknissen/aula (Python, MIT), used as references for the endpoints.
 *
 * Nothing here is official: Aula offers parents no API. This is the unofficial route every community integration uses.
 */
import { allowPrivate } from "../ssrf";

export const AULA_OAUTH = Object.freeze({
  clientId: "_99949a54b8b65423862aac1bf629599ed64231607a",
  scope: "aula-sensitive",
  redirectUri: "https://app-private.aula.dk",
  authorizePath: "/simplesaml/module.php/oidc/authorize.php",
  tokenPath: "/simplesaml/module.php/oidc/token.php",
});

export const AULA_DEFAULT_BASES = Object.freeze({
  auth: "https://login.aula.dk",
  api: "https://www.aula.dk",
  web: "https://www.aula.dk/portal/",
});

export type AulaBases = { auth: string; api: string; web: string };

/** The version to start probing from when nothing is saved (aula-mcp: v24 since 2026-09; nickknissen/aula: v25). */
export const API_VERSION_START = 24;
/** Never probe past this (a bad answer must not walk forever). */
export const API_VERSION_MAX = 60;

/** Envelope sub-codes (nickknissen/aula api_client.py). */
export const SUBCODE = { deactivated: 7, stepUp: 8, invalidToken: 9, sessionExpired: 13 } as const;

/**
 * Where to talk to. Production always uses Aula's own addresses. A local mock (for development and tests) may be named
 * in the connection's config, but only where the SSRF guard lets connectors reach this computer (development, or
 * CONNECTORS_ALLOW_PRIVATE=1); everywhere else the override is ignored.
 */
export function aulaBases(override: string | null | undefined, env: Record<string, string | undefined> = process.env): AulaBases {
  const o = override?.trim();
  if (o && allowPrivate(env)) {
    try {
      const u = new URL(o);
      const base = `${u.protocol}//${u.host}`;
      return { auth: base, api: base, web: `${base}/portal/` };
    } catch { /* ignored: fall back to Aula */ }
  }
  return { ...AULA_DEFAULT_BASES };
}

/** Links into Aula's own web app, so every item can be opened where it came from. */
export function aulaLinks(web: string) {
  const root = web.endsWith("/") ? web : `${web}/`;
  return {
    thread: (id: string | number) => `${root}#/beskeder/${encodeURIComponent(String(id))}`,
    post: (id: string | number) => `${root}#/overblik?post=${encodeURIComponent(String(id))}`,
    event: (id: string | number) => `${root}#/kalender/event/${encodeURIComponent(String(id))}`,
    album: (id: string | number) => `${root}#/galleri/album/${encodeURIComponent(String(id))}`,
    media: (albumId: string | number, mediaId: string | number) => `${root}#/galleri/album/${encodeURIComponent(String(albumId))}/medie/${encodeURIComponent(String(mediaId))}`,
    presence: () => `${root}#/komme-gaa`,
  };
}

/** The sign-in address the helper opens in the parent's own browser (PKCE S256, as the Aula app does). */
export function authorizeUrl(authBase: string, p: { state: string; codeChallenge: string }): string {
  const q = new URLSearchParams({
    response_type: "code", client_id: AULA_OAUTH.clientId, scope: AULA_OAUTH.scope, redirect_uri: AULA_OAUTH.redirectUri,
    state: p.state, code_challenge: p.codeChallenge, code_challenge_method: "S256",
  });
  return `${authBase}${AULA_OAUTH.authorizePath}?${q.toString()}`;
}
