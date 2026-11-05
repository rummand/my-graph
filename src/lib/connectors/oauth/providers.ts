/**
 * The OAuth providers whose connectors sign in with the household's OWN developer app (pure, no DB, no network):
 * Google (Gmail, Google Calendar, Google Drive), Microsoft (Outlook.com / Microsoft 365), Dropbox, Slack and Notion. Each provider's
 * client id and secret come from the environment; when they are missing, the connector card shows the setup guide
 * instead of a sign-in button.
 *
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_PICKER_API_KEY (the Drive file picker's browser key)
 *   MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, MICROSOFT_TENANT (default "common"; "consumers" for Outlook.com only)
 *   DROPBOX_APP_KEY, DROPBOX_APP_SECRET
 *   SLACK_CLIENT_ID, SLACK_CLIENT_SECRET (a Slack app with user-token scopes)
 *   NOTION_CLIENT_ID, NOTION_CLIENT_SECRET (a Notion public integration)
 *   GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET (a GitHub App with read-only permissions; a classic OAuth App also works)
 *   LINEAR_CLIENT_ID, LINEAR_CLIENT_SECRET (a Linear OAuth application, scope read)
 *
 * Every provider URL goes through `endpoint()`, so the tests and local mocks can point the whole provider at a mock
 * server with CONNECTORS_MOCK_BASE (ignored in production): https://oauth2.googleapis.com/token becomes
 * <base>/oauth2.googleapis.com/token. Outbound calls still go through the SSRF guard.
 */
export type ProviderId = "google" | "microsoft" | "dropbox" | "slack" | "notion" | "github" | "linear";
export type Env = Record<string, string | undefined>;

/** The connectors that sign in with one of these providers, and which provider. */
export const OAUTH_CONNECTORS = {
  gmail: "google",
  google_calendar: "google",
  google_drive: "google",
  google_contacts: "google",
  google_photos: "google",
  microsoft: "microsoft",
  dropbox: "dropbox",
  slack: "slack",
  notion: "notion",
  github_oauth: "github",
  linear_oauth: "linear",
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
  google_contacts: ["openid", "email", "https://www.googleapis.com/auth/contacts.readonly"],
  // Google Photos only through its picker: My Graph sees the photos the person picks, nothing else in the library.
  google_photos: ["openid", "email", "https://www.googleapis.com/auth/photospicker.mediaitems.readonly"],
  microsoft: ["offline_access", "openid", "email", "User.Read", "Mail.Read", "Calendars.Read", "Files.Read"],
  dropbox: ["account_info.read", "files.metadata.read", "files.content.read"],
  // Slack: a USER token (user_scope), read only. Direct messages only when the person opts in (scopesFor).
  slack: ["channels:history", "channels:read", "groups:history", "groups:read", "users:read", "users:read.email"],
  // Notion has no scopes: the person picks the pages and databases on Notion's own consent page (read content).
  notion: [],
  // GitHub: a GitHub App ignores scopes (its read-only permissions are set on the app); a classic OAuth App gets
  // only the profile and email, never "repo" (which would be read AND write). See the setup guide.
  github_oauth: ["read:user", "user:email"],
  linear_oauth: ["read"],
};

/** Slack's extra read scopes for direct and group messages, asked for only when the person ticked them. */
export const SLACK_DM_SCOPES = ["im:history", "im:read", "mpim:history", "mpim:read"];

/** The scopes one sign-in asks for, given the connection's settings (Slack DMs are opt-in). */
export function scopesFor(connector: OAuthConnectorId, config: Record<string, unknown> = {}): string[] {
  if (connector === "slack" && config.directMessages === true) return [...SCOPES.slack, ...SLACK_DM_SCOPES];
  return SCOPES[connector];
}

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
  /** How scopes are joined (Slack: commas). */
  scopeSeparator: " " | ",";
  /** The consent page's parameter for the scopes (Slack's user token: user_scope; Notion: none). Default "scope". */
  scopeParam?: "scope" | "user_scope" | null;
  /** PKCE (code_challenge / code_verifier). Default on; Notion's consent page doesn't take it. */
  pkce?: boolean;
  /** How the token endpoint wants the app's credentials: in the form (default) or as HTTP Basic (Notion). */
  tokenAuth?: "body" | "basic";
  /** The token request's body: a form (default) or JSON (Notion). */
  tokenFormat?: "form" | "json";
  /** Turn the token endpoint's answer into the usual OAuth shape (Slack nests the user token and answers 200 + ok:false). */
  unwrapToken?: (body: Record<string, unknown> | null) => Record<string, unknown> | null;
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
  if (id === "slack") {
    const clientId = get("SLACK_CLIENT_ID"), clientSecret = get("SLACK_CLIENT_SECRET");
    return {
      id, clientId, clientSecret,
      authorizeUrl: endpoint("https://slack.com/oauth/v2/authorize", env),
      tokenUrl: endpoint("https://slack.com/api/oauth.v2.access", env),
      revokeUrl: endpoint("https://slack.com/api/auth.revoke", env),
      authorizeParams: {},
      scopeSeparator: ",", scopeParam: "user_scope",
      unwrapToken: unwrapSlackToken,
      envNames: ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET"],
      missing: [!clientId && "SLACK_CLIENT_ID", !clientSecret && "SLACK_CLIENT_SECRET"].filter(Boolean) as string[],
    };
  }
  if (id === "notion") {
    const clientId = get("NOTION_CLIENT_ID"), clientSecret = get("NOTION_CLIENT_SECRET");
    return {
      id, clientId, clientSecret,
      authorizeUrl: endpoint("https://api.notion.com/v1/oauth/authorize", env),
      tokenUrl: endpoint("https://api.notion.com/v1/oauth/token", env),
      revokeUrl: null,
      authorizeParams: { owner: "user" },
      scopeSeparator: " ", scopeParam: null, pkce: false, tokenAuth: "basic", tokenFormat: "json",
      envNames: ["NOTION_CLIENT_ID", "NOTION_CLIENT_SECRET"],
      missing: [!clientId && "NOTION_CLIENT_ID", !clientSecret && "NOTION_CLIENT_SECRET"].filter(Boolean) as string[],
    };
  }
  if (id === "github") {
    const clientId = get("GITHUB_CLIENT_ID"), clientSecret = get("GITHUB_CLIENT_SECRET");
    return {
      id, clientId, clientSecret,
      authorizeUrl: endpoint("https://github.com/login/oauth/authorize", env),
      tokenUrl: endpoint("https://github.com/login/oauth/access_token", env),
      revokeUrl: null,
      authorizeParams: { allow_signup: "false", prompt: "select_account" },
      scopeSeparator: " ",
      unwrapToken: unwrapGithubToken,
      envNames: ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
      missing: [!clientId && "GITHUB_CLIENT_ID", !clientSecret && "GITHUB_CLIENT_SECRET"].filter(Boolean) as string[],
    };
  }
  if (id === "linear") {
    const clientId = get("LINEAR_CLIENT_ID"), clientSecret = get("LINEAR_CLIENT_SECRET");
    return {
      id, clientId, clientSecret,
      authorizeUrl: endpoint("https://linear.app/oauth/authorize", env),
      tokenUrl: endpoint("https://api.linear.app/oauth/token", env),
      revokeUrl: endpoint("https://api.linear.app/oauth/revoke", env),
      authorizeParams: { prompt: "consent", actor: "user" },
      scopeSeparator: ",",
      envNames: ["LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET"],
      missing: [!clientId && "LINEAR_CLIENT_ID", !clientSecret && "LINEAR_CLIENT_SECRET"].filter(Boolean) as string[],
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

/**
 * Slack's oauth.v2.access answer (pure): the user token sits in `authed_user`, and a refusal is HTTP 200 with
 * { ok: false, error }. Turned into the usual shape, with Slack's error names mapped onto OAuth's.
 */
export function unwrapSlackToken(body: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!body) return null;
  if (body.ok === false) {
    const e = typeof body.error === "string" ? body.error : "error";
    const mapped = /^(invalid_code|code_already_used|invalid_refresh_token|invalid_grant_type|token_revoked|token_expired)$/.test(e) ? "invalid_grant"
      : /^(invalid_client_id|bad_client_secret|invalid_client)$/.test(e) ? "invalid_client" : e;
    return { error: mapped, error_description: e };
  }
  // The first sign-in nests the user token in authed_user; a refresh (token rotation) answers at the top level.
  const nested = (body.authed_user ?? {}) as Record<string, unknown>;
  const u = typeof nested.access_token === "string" ? nested : body;
  if (typeof u.access_token !== "string") return { error: "no_user_token", error_description: "Slack didn't give a user token." };
  return { access_token: u.access_token, refresh_token: u.refresh_token, expires_in: u.expires_in, scope: u.scope };
}

/** GitHub's token endpoint refuses with HTTP 200 and its own error names: mapped onto OAuth's (pure). */
export function unwrapGithubToken(body: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!body || typeof body.error !== "string") return body;
  const e = body.error;
  const mapped = /^(bad_verification_code|bad_refresh_token|expired_token)$/.test(e) ? "invalid_grant"
    : /^(incorrect_client_credentials|unauthorized_client)$/.test(e) ? "invalid_client" : e;
  return { ...body, error: mapped, error_description: typeof body.error_description === "string" ? body.error_description : e };
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
export function buildAuthorizeUrl(p: ProviderInfo, connector: OAuthConnectorId, o: { redirectUri: string; state: string; challenge: string; loginHint?: string | null; scopes?: string[] }): string {
  if (!p.clientId) throw new Error("This provider isn't set up.");
  const u = new URL(p.authorizeUrl);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", p.clientId);
  u.searchParams.set("redirect_uri", o.redirectUri);
  u.searchParams.set("state", o.state);
  if (p.pkce !== false) {
    u.searchParams.set("code_challenge", o.challenge);
    u.searchParams.set("code_challenge_method", "S256");
  }
  const scopeParam = p.scopeParam === undefined ? "scope" : p.scopeParam;
  if (scopeParam) u.searchParams.set(scopeParam, (o.scopes ?? SCOPES[connector]).join(p.scopeSeparator));
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
    people: endpoint("https://people.googleapis.com/v1", env),
    photosPicker: endpoint("https://photospicker.googleapis.com/v1", env),
    googleUser: endpoint("https://openidconnect.googleapis.com/v1/userinfo", env),
    graph: endpoint("https://graph.microsoft.com/v1.0", env),
    dropbox: endpoint("https://api.dropboxapi.com/2", env),
    dropboxContent: endpoint("https://content.dropboxapi.com/2", env),
    slack: endpoint("https://slack.com/api", env),
    notion: endpoint("https://api.notion.com/v1", env),
    github: endpoint("https://api.github.com", env),
    linear: endpoint("https://api.linear.app/graphql", env),
  };
}
