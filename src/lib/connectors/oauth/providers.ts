/**
 * The three OAuth providers whose connectors sign in with the household's OWN developer app (pure, no DB, no network):
 * Google (Gmail, Google Calendar, Google Drive), Microsoft (Outlook.com / Microsoft 365) and Dropbox. Each provider's
 * client id and secret come from the environment; when they are missing, the connector card shows the setup guide
 * instead of a sign-in button.
 *
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_PICKER_API_KEY (the Drive file picker's browser key)
 *   MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, MICROSOFT_TENANT (default "common"; "consumers" for Outlook.com only)
 *   DROPBOX_APP_KEY, DROPBOX_APP_SECRET
 *
 * Every provider URL goes through `endpoint()`, so the tests and local mocks can point the whole provider at a mock
 * server with CONNECTORS_MOCK_BASE (ignored in production): https://oauth2.googleapis.com/token becomes
 * <base>/oauth2.googleapis.com/token. Outbound calls still go through the SSRF guard.
 */
export type ProviderId = "google" | "microsoft" | "dropbox";
export type Env = Record<string, string | undefined>;

/** The connectors that sign in with one of these providers, and which provider. */
export const OAUTH_CONNECTORS = {
  gmail: "google",
  google_calendar: "google",
  google_drive: "google",
  microsoft: "microsoft",
  dropbox: "dropbox",
} as const satisfies Record<string, ProviderId>;
export type OAuthConnectorId = keyof typeof OAUTH_CONNECTORS;

export function isOAuthConnector(id: string): id is OAuthConnectorId {
  return Object.prototype.hasOwnProperty.call(OAUTH_CONNECTORS, id);
}

export function providerOf(connector: string): ProviderId | null {
  return isOAuthConnector(connector) ? OAUTH_CONNECTORS[connector] : null;
}

/** What each connector asks the provider for. Read-only everywhere; Drive only sees what the person picks. */
export const SCOPES: Record<OAuthConnectorId, string[]> = {
  gmail: ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly"],
  google_calendar: ["openid", "email", "https://www.googleapis.com/auth/calendar.readonly"],
  google_drive: ["openid", "email", "https://www.googleapis.com/auth/drive.file"],
  microsoft: ["offline_access", "openid", "email", "User.Read", "Mail.Read", "Calendars.Read", "Files.Read"],
  dropbox: ["account_info.read", "files.metadata.read", "files.content.read"],
};

/** The scope the connector can't work without (Google lets a person untick it on the consent page). */
export function missingScope(connector: OAuthConnectorId, granted: string | null): string | null {
  if (!granted) return null;
  const have = new Set(granted.split(/[\s,]+/).map((s) => s.toLowerCase()));
  const need = SCOPES[connector].filter((s) => !["openid", "email", "offline_access", "user.read", "account_info.read"].includes(s.toLowerCase()));
  // Microsoft answers with short names ("Mail.Read") or full ones ("https://graph.microsoft.com/Mail.Read").
  const ok = (s: string) => have.has(s.toLowerCase()) || [...have].some((h) => h.endsWith(`/${s.toLowerCase()}`));
  return need.find((s) => !ok(s)) ?? null;
}

/** Rewrite a provider URL to the mock server in development and tests. */
export function endpoint(url: string, env: Env = process.env): string {
  const base = env.CONNECTORS_MOCK_BASE?.trim();
  if (!base || env.NODE_ENV === "production") return url;
  const u = new URL(url);
  return `${base.replace(/\/+$/, "")}/${u.host}${u.pathname}${u.search}`;
}

export type ProviderInfo = {
  id: ProviderId;
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl: string | null;
  /** Extra parameters on the consent page (Google: offline access and a fresh consent so a refresh token comes back). */
  authorizeParams: Record<string, string>;
  /** Scopes joined with spaces (all three). */
  scopeSeparator: " ";
  clientId: string | null;
  clientSecret: string | null;
  /** Names of the settings the owner sets (shown in the guide). */
  envNames: string[];
  /** Missing settings, by name (empty = ready). */
  missing: string[];
};

export function providerInfo(id: ProviderId, env: Env = process.env): ProviderInfo {
  const get = (k: string) => env[k]?.trim() || null;
  if (id === "google") {
    const clientId = get("GOOGLE_CLIENT_ID"), clientSecret = get("GOOGLE_CLIENT_SECRET");
    return {
      id, clientId, clientSecret,
      authorizeUrl: endpoint("https://accounts.google.com/o/oauth2/v2/auth", env),
      tokenUrl: endpoint("https://oauth2.googleapis.com/token", env),
      revokeUrl: endpoint("https://oauth2.googleapis.com/revoke", env),
      authorizeParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "false" },
      scopeSeparator: " ",
      envNames: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_PICKER_API_KEY"],
      missing: [!clientId && "GOOGLE_CLIENT_ID", !clientSecret && "GOOGLE_CLIENT_SECRET"].filter(Boolean) as string[],
    };
  }
  if (id === "microsoft") {
    const clientId = get("MICROSOFT_CLIENT_ID"), clientSecret = get("MICROSOFT_CLIENT_SECRET");
    const tenant = (get("MICROSOFT_TENANT") ?? "common").replace(/[^a-zA-Z0-9.-]/g, "") || "common";
    return {
      id, clientId, clientSecret,
      authorizeUrl: endpoint(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`, env),
      tokenUrl: endpoint(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, env),
      revokeUrl: null,
      authorizeParams: { response_mode: "query", prompt: "select_account" },
      scopeSeparator: " ",
      envNames: ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET", "MICROSOFT_TENANT"],
      missing: [!clientId && "MICROSOFT_CLIENT_ID", !clientSecret && "MICROSOFT_CLIENT_SECRET"].filter(Boolean) as string[],
    };
  }
  const clientId = get("DROPBOX_APP_KEY"), clientSecret = get("DROPBOX_APP_SECRET");
  return {
    id, clientId, clientSecret,
    authorizeUrl: endpoint("https://www.dropbox.com/oauth2/authorize", env),
    tokenUrl: endpoint("https://api.dropboxapi.com/oauth2/token", env),
    revokeUrl: endpoint("https://api.dropboxapi.com/2/auth/token/revoke", env),
    authorizeParams: { token_access_type: "offline" },
    scopeSeparator: " ",
    envNames: ["DROPBOX_APP_KEY", "DROPBOX_APP_SECRET"],
    missing: [!clientId && "DROPBOX_APP_KEY", !clientSecret && "DROPBOX_APP_SECRET"].filter(Boolean) as string[],
  };
}

export function isConfigured(id: ProviderId, env: Env = process.env): boolean {
  return providerInfo(id, env).missing.length === 0;
}

/** The Drive picker also needs a browser API key; the app id is the project number at the start of the client id. */
export function pickerSettings(env: Env = process.env): { developerKey: string; appId: string | null } | null {
  const key = env.GOOGLE_PICKER_API_KEY?.trim();
  if (!key) return null;
  const m = (env.GOOGLE_CLIENT_ID ?? "").match(/^(\d+)-/);
  return { developerKey: key, appId: env.GOOGLE_PROJECT_NUMBER?.trim() || (m ? m[1] : null) };
}

/** The consent page address for one sign-in (PKCE S256 + state). */
export function buildAuthorizeUrl(p: ProviderInfo, connector: OAuthConnectorId, o: { redirectUri: string; state: string; challenge: string; loginHint?: string | null }): string {
  if (!p.clientId) throw new Error("This provider isn't set up.");
  const u = new URL(p.authorizeUrl);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", p.clientId);
  u.searchParams.set("redirect_uri", o.redirectUri);
  u.searchParams.set("state", o.state);
  u.searchParams.set("code_challenge", o.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("scope", SCOPES[connector].join(p.scopeSeparator));
  for (const [k, v] of Object.entries(p.authorizeParams)) u.searchParams.set(k, v);
  if (o.loginHint) u.searchParams.set("login_hint", o.loginHint);
  return u.toString();
}

/** Base URLs of each provider's APIs (through `endpoint`). */
export function apiBase(env: Env = process.env) {
  return {
    gmail: endpoint("https://gmail.googleapis.com/gmail/v1/users/me", env),
    calendar: endpoint("https://www.googleapis.com/calendar/v3", env),
    drive: endpoint("https://www.googleapis.com/drive/v3", env),
    googleUser: endpoint("https://openidconnect.googleapis.com/v1/userinfo", env),
    graph: endpoint("https://graph.microsoft.com/v1.0", env),
    dropbox: endpoint("https://api.dropboxapi.com/2", env),
    dropboxContent: endpoint("https://content.dropboxapi.com/2", env),
  };
}
