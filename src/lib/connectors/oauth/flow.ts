/**
 * Signing in to Google, Microsoft or Dropbox from Connections (server-only), with the household's own developer app.
 *   start:  a connection is made (or found, to sign in again) waiting for the sign-in ("needs you"); a random state and
 *           a PKCE verifier are kept with it, encrypted, for 15 minutes; the person is sent to the provider's consent
 *           page.
 *   finish: the provider sends the person back to /api/connections/oauth/callback (the same address MCP servers use;
 *           the callback asks `isProviderSignIn` which flow a state belongs to). The state must name a connection of
 *           this person in this graph, match what was kept (constant-time) and be fresh; the code is traded for tokens
 *           with the verifier and the app's secret; the tokens are kept encrypted and the connection runs.
 * Tokens never reach the browser (except the Drive picker's short-lived token, see picker route). The callback only
 * ever redirects to a path on My Graph.
 */
import { timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { connections } from "@/db/schema";
import { audit, type Viewer } from "@/lib/auth";
import { scopeOf } from "@/lib/graphs/pure";
import { pkcePair, randomState } from "@/lib/mcp-client/oauth";
import { guardedTransport, type Transport } from "@/lib/mcp-client/transport";
import { decryptSecrets, encryptSecrets } from "../crypto";
import { ConnectorError } from "../errors";
import { clampEvery } from "../manifest";
import { connectorById, offeredIn } from "../registry";
import { ConnectionError, kick } from "../store";
import { apiFor } from "./session";
import { apiBase, buildAuthorizeUrl, isOAuthConnector, scopesFor, missingScope, providerInfo, providerOf, type OAuthConnectorId } from "./providers";
import { readTokens, tokenRequest, writeTokens, type TokenState } from "./tokens";
import { NOTION_VERSION } from "../notion/api";

const PENDING_MS = 15 * 60_000;
export const CALLBACK_PATH = "/api/connections/oauth/callback";

/** Names shown until the account is known ("Gmail", then "Gmail: anna@gmail.com"). */
export const DEFAULT_TITLES: Record<OAuthConnectorId, string> = {
  gmail: "Gmail", google_calendar: "Google Calendar", google_drive: "Google Drive", google_contacts: "Google Contacts", google_photos: "Google Photos", microsoft: "Outlook and OneDrive", dropbox: "Dropbox",
  slack: "Slack", notion: "Notion", github_oauth: "GitHub", linear_oauth: "Linear",
};

function assertMayConnect(v: Viewer) {
  if (v.role === "guest") throw new ConnectionError(403, "Guests can't connect accounts.");
  if (!scopeOf(v).canWrite) throw new ConnectionError(403, "You can look at this graph but not connect accounts to it.");
}

/** My Graph's own address for the redirect: APP_URL when set, else the address the request came to. */
export function appOrigin(req: Request, env: Record<string, string | undefined> = process.env): string {
  if (env.APP_URL) return new URL(env.APP_URL).origin;
  const h = req.headers;
  const host = h.get("x-forwarded-host")?.split(",")[0]?.trim() || h.get("host") || new URL(req.url).host;
  const proto = h.get("x-forwarded-proto")?.split(",")[0]?.trim() || new URL(req.url).protocol.replace(":", "");
  return `${proto}://${host}`;
}

/** `label` is what the person typed, or (with `autoLabel`) the connector's name in their language, to which the account is added. */
export type StartInput = { connectionId?: string; connector?: string; label?: string; autoLabel?: boolean; config?: Record<string, unknown>; everyMinutes?: number };

export async function startProviderOAuth(v: Viewer, req: Request, input: StartInput): Promise<{ connectionId: string; authorizeUrl: string }> {
  assertMayConnect(v);
  let row: typeof connections.$inferSelect | null = null;
  if (input.connectionId) {
    [row] = await db.select().from(connections).where(and(eq(connections.id, input.connectionId), eq(connections.graphId, v.graphId), eq(connections.userId, v.id))).limit(1);
    if (!row) throw new ConnectionError(404, "This connection doesn't exist, or it isn't yours.");
  }
  const connectorId = row?.connector ?? input.connector ?? "";
  const c = connectorById(connectorId);
  if (!c || !isOAuthConnector(connectorId) || !offeredIn(v.graphKind).includes(c)) throw new ConnectionError(400, "That kind of connection isn't available in this graph.");
  const p = providerInfo(providerOf(connectorId)!);
  if (p.missing.length) throw new ConnectionError(400, `This My Graph hasn't been set up for ${DEFAULT_TITLES[connectorId]} yet. Follow the setup guide on the card.`, "providerNotSetUp");
  const parsed = c.manifest.config.safeParse({ ...(row?.config ?? {}), ...(input.config ?? {}) });
  if (!parsed.success) throw new ConnectionError(400, parsed.error.issues[0]?.message ?? "Some fields need fixing.");
  const config = parsed.data as Record<string, unknown>;

  const id = row?.id ?? crypto.randomUUID();
  const redirectUri = `${appOrigin(req)}${CALLBACK_PATH}`;
  const { verifier, challenge } = pkcePair();
  const state = `${id}.${randomState()}`;
  const current = row ? (() => { try { return decryptSecrets(row!.secrets, row!.id); } catch { return {}; } })() : {};
  const prev = readTokens(current);
  const tokens: TokenState = {
    accessToken: prev?.accessToken ?? null, refreshToken: prev?.refreshToken ?? null, expiresAt: prev?.expiresAt ?? null, scope: prev?.scope ?? null,
    redirectUri: prev?.redirectUri ?? null, pending: { state, verifier, redirectUri, expiresAt: Date.now() + PENDING_MS, autoLabel: !row && (input.autoLabel || !input.label?.trim()) },
  };
  const secrets = writeTokens(current, tokens);
  if (row) {
    await db.update(connections).set({ config, secrets: encryptSecrets(secrets, id), updatedAt: new Date() }).where(eq(connections.id, id));
  } else {
    const label = (input.label?.trim() || DEFAULT_TITLES[connectorId]).slice(0, 120);
    await db.insert(connections).values({
      id, graphId: v.graphId, userId: v.id, connector: connectorId, label, config, secrets: encryptSecrets(secrets, id), state: {},
      status: "needs_you", statusDetail: "signIn|Finish signing in to connect it.", everyMinutes: clampEvery(input.everyMinutes, c.manifest), nextRunAt: null,
    });
    void audit(v, "connections.create", { type: "connection", id }, { connector: connectorId, auth: "oauth" }).catch(() => {});
  }
  const account = typeof config.account === "string" ? config.account : null;
  return { connectionId: id, authorizeUrl: buildAuthorizeUrl(p, connectorId, { redirectUri, state, challenge, loginHint: account, scopes: scopesFor(connectorId, config) }) };
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function idOfState(state: string | null): string | null {
  const m = (state ?? "").match(/^([0-9a-f-]{36})\.[A-Za-z0-9_-]{16,}$/i);
  return m ? m[1] : null;
}

/** Is this callback for one of the provider connectors (rather than an MCP server)? */
export async function isProviderSignIn(v: Viewer, state: string | null): Promise<boolean> {
  const id = idOfState(state);
  if (!id) return false;
  const [row] = await db.select({ connector: connections.connector }).from(connections).where(and(eq(connections.id, id), eq(connections.userId, v.id))).limit(1);
  return !!row && isOAuthConnector(row.connector);
}

/** Who signed in, for the card ("anna@gmail.com"). Best effort: a failure leaves it empty. */
export async function accountOf(conn: { id: string; connector: string }, secrets: Record<string, string>, transport?: Transport): Promise<string | null> {
  try {
    const api = apiFor(conn, secrets, { transport });
    const base = apiBase();
    const provider = providerOf(conn.connector);
    if (provider === "google") {
      const r = await api({ url: base.googleUser });
      return r.status === 200 ? (r.json<{ email?: string }>()?.email ?? null) : null;
    }
    if (provider === "microsoft") {
      const r = await api({ url: `${base.graph}/me?$select=mail,userPrincipalName` });
      const b = r.status === 200 ? r.json<{ mail?: string; userPrincipalName?: string }>() : null;
      return b?.mail ?? b?.userPrincipalName ?? null;
    }
    if (provider === "slack") {
      // auth.test: who and which workspace ("anna @ Acme"). Slack answers 200 with ok:false on a problem.
      const r = await api({ url: `${base.slack}/auth.test`, method: "POST" });
      const b = r.status === 200 ? r.json<{ ok?: boolean; user?: string; team?: string }>() : null;
      return b?.ok && b.user ? (b.team ? `${b.user} @ ${b.team}` : b.user) : null;
    }
    if (provider === "notion") {
      // The integration's own bot user carries the workspace name and the person who connected it.
      const r = await api({ url: `${base.notion}/users/me`, headers: { "notion-version": NOTION_VERSION } });
      const b = r.status === 200 ? r.json<{ bot?: { workspace_name?: string; owner?: { user?: { person?: { email?: string } } } } }>() : null;
      return b?.bot?.workspace_name ?? b?.bot?.owner?.user?.person?.email ?? null;
    }
    if (provider === "github") {
      const r = await api({ url: `${base.github}/user`, headers: { accept: "application/vnd.github+json" } });
      const b = r.status === 200 ? r.json<{ login?: string }>() : null;
      return b?.login ?? null;
    }
    if (provider === "linear") {
      const r = await api({ url: base.linear, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "{ viewer { email organization { name } } }" }) });
      const b = r.status === 200 ? r.json<{ data?: { viewer?: { email?: string; organization?: { name?: string } } } }>() : null;
      const v = b?.data?.viewer;
      return v?.email ? (v.organization?.name ? `${v.email} @ ${v.organization.name}` : v.email) : null;
    }
    const r = await api({ url: `${base.dropbox}/users/get_current_account`, method: "POST", headers: { "content-type": "application/json" }, body: "null" });
    return r.status === 200 ? (r.json<{ email?: string }>()?.email ?? null) : null;
  } catch {
    return null;
  }
}

export type FinishParams = { code: string | null; state: string | null; error: string | null; errorDescription: string | null };

/** Finish a sign-in from the callback. Returns the connection id. Throws ConnectionError with a plain reason. */
export async function finishProviderOAuth(v: Viewer, params: FinishParams, transport: Transport = guardedTransport()): Promise<string> {
  const id = idOfState(params.state);
  if (!id) throw new ConnectionError(400, "This sign-in link isn't valid. Start again from Connections.");
  const [row] = await db.select().from(connections).where(and(eq(connections.id, id), eq(connections.userId, v.id))).limit(1);
  if (!row || !isOAuthConnector(row.connector)) throw new ConnectionError(404, "This sign-in isn't for a connection of yours.");
  if (row.graphId !== v.graphId) throw new ConnectionError(409, "Switch back to the graph you started connecting from, then try again.");
  const connectorId = row.connector as OAuthConnectorId;
  let secrets: Record<string, string>;
  try { secrets = decryptSecrets(row.secrets, row.id); } catch { throw new ConnectionError(400, "The sign-in couldn't be read. Start again."); }
  const t = readTokens(secrets);
  const pend = t?.pending;
  if (!t || !pend || !same(pend.state, params.state ?? "")) throw new ConnectionError(400, "This sign-in has already been used or was replaced. Start again.");
  // Single use: the pending sign-in is spent whatever happens next.
  const spent = writeTokens(secrets, { ...t, pending: null });
  await db.update(connections).set({ secrets: encryptSecrets(spent, id) }).where(eq(connections.id, id));
  if (pend.expiresAt < Date.now()) throw new ConnectionError(400, "The sign-in took too long. Start again.");
  if (params.error) {
    throw new ConnectionError(400, params.error === "access_denied"
      ? "You said no on the sign-in page, so nothing was connected."
      : `The sign-in didn't finish: ${(params.errorDescription ?? params.error).slice(0, 200)}.`);
  }
  if (!params.code) throw new ConnectionError(400, "The sign-in page didn't send a code back.");

  const p = providerInfo(providerOf(connectorId)!);
  let a;
  try {
    a = await tokenRequest(transport, p, { grant_type: "authorization_code", code: params.code, redirect_uri: pend.redirectUri, code_verifier: pend.verifier });
  } catch (e) {
    if (e instanceof ConnectorError) throw new ConnectionError(400, e.code === "signInAgain" ? "The sign-in code was refused (it may have been used already). Start again." : e.message, e.code);
    throw e;
  }
  const next: TokenState = {
    accessToken: a.accessToken, refreshToken: a.refreshToken ?? t.refreshToken, expiresAt: a.expiresAt, scope: a.scope, redirectUri: pend.redirectUri, pending: null,
  };
  const merged = writeTokens(secrets, next);
  const account = await accountOf({ id, connector: connectorId }, { ...merged }, transport);
  const lacking = missingScope(connectorId, a.scope);
  // A name nobody typed gets the account added ("Gmail: anna@gmail.com"), once, on the first sign-in.
  const label = account && pend.autoLabel && !row.label.includes(account) ? `${row.label}: ${account}`.slice(0, 120) : row.label;
  const c = connectorById(connectorId);
  await db.update(connections).set({
    secrets: encryptSecrets(merged, id), label,
    config: { ...(row.config ?? {}), ...(account ? { account } : {}) },
    status: lacking ? "needs_you" : "ok",
    statusDetail: lacking ? `scopeMissing|The sign-in didn't allow ${lacking.replace(/^https:\/\/www\.googleapis\.com\/auth\//, "")}. Sign in again and leave it ticked.` : null,
    nextRunAt: lacking ? null : new Date(), updatedAt: new Date(),
    everyMinutes: c ? clampEvery(row.everyMinutes, c.manifest) : row.everyMinutes,
  }).where(eq(connections.id, id));
  void audit(v, "connections.signIn", { type: "connection", id }, { connector: connectorId }).catch(() => {});
  if (!lacking) kick(id, v.graphId);
  return id;
}

/** The current access token for the Drive picker (the person's own, short-lived, drive.file only). */
export async function pickerToken(v: Viewer, id: string): Promise<{ accessToken: string; expiresAt: number | null }> {
  const [row] = await db.select().from(connections).where(and(eq(connections.id, id), eq(connections.graphId, v.graphId), eq(connections.userId, v.id))).limit(1);
  if (!row) throw new ConnectionError(404, "This connection doesn't exist, or it isn't yours.");
  if (row.connector !== "google_drive") throw new ConnectionError(400, "Only a Google Drive connection picks files this way.");
  let secrets: Record<string, string>;
  try { secrets = decryptSecrets(row.secrets, row.id); } catch { throw new ConnectionError(400, "Sign in again first.", "signInAgain"); }
  const api = apiFor(row, secrets);
  // A cheap authorised call refreshes the token when it is ending.
  const r = await api({ url: `${apiBase().drive}/about?fields=user(emailAddress)` }).catch((e) => {
    throw new ConnectionError(400, e instanceof Error ? e.message : "Sign in again first.", "signInAgain");
  });
  if (r.status !== 200) throw new ConnectionError(400, "Google didn't accept the sign-in. Sign in again first.", "signInAgain");
  const t = readTokens(secrets);
  if (!t?.accessToken) throw new ConnectionError(400, "Sign in again first.", "signInAgain");
  return { accessToken: t.accessToken, expiresAt: t.expiresAt };
}
