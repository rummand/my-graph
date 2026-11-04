/**
 * Signing in to an MCP server from Connections (server-only).
 *   start:  find the server's authorization server (RFC 9728 → RFC 8414), register My Graph as a client (RFC 7591),
 *           keep the PKCE verifier and a random state with the connection (encrypted), and hand back the consent URL.
 *           A new connection is made here, waiting for the sign-in ("needs you"), and is not run until it finishes.
 *   finish: the server sends the person back to /api/connections/oauth/callback with code + state; the state names
 *           the connection, must match what was kept and must be fresh; the code is traded for tokens (PKCE), which
 *           are kept encrypted; the connection then runs.
 * The token never reaches the browser. The callback only ever redirects to a path on My Graph itself.
 */
import { timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { connections } from "@/db/schema";
import { audit, type Viewer } from "@/lib/auth";
import { scopeOf } from "@/lib/graphs/pure";
import { McpError } from "@/lib/mcp-client/errors";
import { authorizeUrl, discover, exchangeCode, pkcePair, randomState, register } from "@/lib/mcp-client/oauth";
import { guardedTransport, type Transport } from "@/lib/mcp-client/transport";
import { decryptSecrets, encryptSecrets } from "../crypto";
import { clampEvery } from "../manifest";
import { connectorById, MCP_CONNECTORS, offeredIn } from "../registry";
import { ConnectionError, kick } from "../store";
import { mcpConfig, readOAuth, type OAuthState } from "./config";

const PENDING_MS = 15 * 60_000;

export const CALLBACK_PATH = "/api/connections/oauth/callback";

/** My Graph's own address for the redirect: APP_URL when set, else the address the request came to. */
export function appOrigin(req: Request, env: Record<string, string | undefined> = process.env): string {
  if (env.APP_URL) return new URL(env.APP_URL).origin;
  const h = req.headers;
  const host = h.get("x-forwarded-host")?.split(",")[0]?.trim() || h.get("host") || new URL(req.url).host;
  const proto = h.get("x-forwarded-proto")?.split(",")[0]?.trim() || new URL(req.url).protocol.replace(":", "");
  return `${proto}://${host}`;
}

function assertMayConnect(v: Viewer) {
  if (v.role === "guest") throw new ConnectionError(403, "Guests can't connect accounts.");
  if (!scopeOf(v).canWrite) throw new ConnectionError(403, "You can look at this graph but not connect accounts to it.");
}

function asConnError(e: unknown): never {
  if (e instanceof McpError) throw new ConnectionError(400, e.message, e.code === "privateHost" ? "privateHost" : e.code === "badUrl" ? "badUrl" : "oauth");
  throw e;
}

export type StartInput = { connectionId?: string; connector?: string; label?: string; config?: Record<string, unknown>; everyMinutes?: number };

/** Begin a sign-in. Returns where to send the person, and the connection it is for. */
export async function startOAuth(v: Viewer, req: Request, input: StartInput, transport: Transport = guardedTransport()): Promise<{ connectionId: string; authorizeUrl: string }> {
  assertMayConnect(v);
  let row: typeof connections.$inferSelect | null = null;
  if (input.connectionId) {
    [row] = await db.select().from(connections).where(and(eq(connections.id, input.connectionId), eq(connections.graphId, v.graphId), eq(connections.userId, v.id))).limit(1);
    if (!row) throw new ConnectionError(404, "This connection doesn't exist, or it isn't yours.");
    if (!MCP_CONNECTORS.has(row.connector)) throw new ConnectionError(400, "This connection doesn't sign in this way.");
  }
  const connectorId = row?.connector ?? input.connector ?? "";
  const c = connectorById(connectorId);
  if (!c || !MCP_CONNECTORS.has(connectorId) || !offeredIn(v.graphKind).includes(c)) throw new ConnectionError(400, "That kind of connection isn't available in this graph.");
  const parsed = mcpConfig.safeParse({ ...(row?.config ?? {}), ...(input.config ?? {}), authMode: "oauth" });
  if (!parsed.success) throw new ConnectionError(400, parsed.error.issues[0]?.message ?? "Some fields need fixing.");
  const config = { ...parsed.data, feedHost: (() => { try { return new URL(parsed.data.serverUrl).hostname; } catch { return undefined; } })() };

  const redirectUri = `${appOrigin(req)}${CALLBACK_PATH}`;
  const found = await discover(transport, config.serverUrl).catch(asConnError);
  const current = row ? (() => { try { return decryptSecrets(row!.secrets, row!.id); } catch { return {}; } })() : {};
  const prev = readOAuth(current);
  // Register once per authorization server and return address; reuse it afterwards.
  const reg = prev && prev.issuer === found.issuer && prev.redirectUri === redirectUri
    ? { clientId: prev.clientId, clientSecret: prev.clientSecret ?? null }
    : await register(transport, found.meta, redirectUri, "My Graph").catch(asConnError);

  const id = row?.id ?? crypto.randomUUID();
  const { verifier, challenge } = pkcePair();
  const state = `${id}.${randomState()}`;
  const scope = found.scopes.includes("read") ? (found.scopes.includes("write") ? "read write" : "read") : null;
  const oauth: OAuthState = {
    issuer: found.issuer, tokenEndpoint: found.meta.token_endpoint, authorizationEndpoint: found.meta.authorization_endpoint,
    revocationEndpoint: found.meta.revocation_endpoint ?? null, resource: found.resource, clientId: reg.clientId, clientSecret: reg.clientSecret,
    redirectUri, accessToken: prev?.accessToken ?? null, refreshToken: prev?.refreshToken ?? null, expiresAt: prev?.expiresAt ?? null, scope: prev?.scope ?? null,
    pending: { state, verifier, expiresAt: Date.now() + PENDING_MS },
  };
  const secrets = { ...current, oauth: JSON.stringify(oauth) };
  delete (secrets as Record<string, string>).apiKey;

  if (row) {
    await db.update(connections).set({ config, secrets: encryptSecrets(secrets, id), updatedAt: new Date() }).where(eq(connections.id, id));
  } else {
    const label = (input.label?.trim() || (connectorId === "record" ? "Record" : `MCP server at ${config.feedHost ?? "?"}`)).slice(0, 120);
    await db.insert(connections).values({
      id, graphId: v.graphId, userId: v.id, connector: connectorId, label, config, secrets: encryptSecrets(secrets, id), state: {},
      status: "needs_you", statusDetail: "signIn|Finish signing in to connect it.", everyMinutes: clampEvery(input.everyMinutes, c.manifest), nextRunAt: null,
    });
    void audit(v, "connections.create", { type: "connection", id }, { connector: connectorId, auth: "oauth" }).catch(() => {});
  }
  return { connectionId: id, authorizeUrl: authorizeUrl(found.meta, { clientId: reg.clientId, redirectUri, challenge, state, resource: found.resource, scope }) };
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** The connection id a state names (before anything is trusted), or null. */
export function connectionIdOfState(state: string | null): string | null {
  const m = (state ?? "").match(/^([0-9a-f-]{36})\.[A-Za-z0-9_-]{16,}$/i);
  return m ? m[1] : null;
}

/** Finish a sign-in from the callback. Returns the connection id. Throws ConnectionError with a plain reason. */
export async function finishOAuth(v: Viewer, params: { code: string | null; state: string | null; iss: string | null; error: string | null; errorDescription: string | null }, transport: Transport = guardedTransport()): Promise<string> {
  const id = connectionIdOfState(params.state);
  if (!id) throw new ConnectionError(400, "This sign-in link isn't valid. Start again from Connections.");
  const [row] = await db.select().from(connections).where(and(eq(connections.id, id), eq(connections.userId, v.id))).limit(1);
  if (!row) throw new ConnectionError(404, "This sign-in isn't for a connection of yours.");
  if (row.graphId !== v.graphId) throw new ConnectionError(409, "Switch back to the graph you started connecting from, then try again.");
  let secrets: Record<string, string>;
  try { secrets = decryptSecrets(row.secrets, row.id); } catch { throw new ConnectionError(400, "The sign-in couldn't be read. Start again."); }
  const o = readOAuth(secrets);
  const p = o?.pending;
  if (!o || !p || !same(p.state, params.state ?? "")) throw new ConnectionError(400, "This sign-in has already been used or was replaced. Start again.");
  if (p.expiresAt < Date.now()) throw new ConnectionError(400, "The sign-in took too long. Start again.");
  if (params.error) {
    const cleared = { ...secrets, oauth: JSON.stringify({ ...o, pending: null }) };
    await db.update(connections).set({ secrets: encryptSecrets(cleared, id) }).where(eq(connections.id, id));
    throw new ConnectionError(400, params.error === "access_denied" ? "You said no on the server's page, so nothing was connected." : `The server didn't sign you in: ${(params.errorDescription ?? params.error).slice(0, 200)}.`);
  }
  if (params.iss && params.iss.replace(/\/+$/, "") !== o.issuer.replace(/\/+$/, "")) throw new ConnectionError(400, "The answer came from another server than the one you signed in to.");
  if (!params.code) throw new ConnectionError(400, "The server didn't send a sign-in code.");

  let tokens;
  try {
    tokens = await exchangeCode(transport, { token_endpoint: o.tokenEndpoint }, { clientId: o.clientId, clientSecret: o.clientSecret ?? null }, { code: params.code, verifier: p.verifier, redirectUri: o.redirectUri, resource: o.resource });
  } catch (e) {
    if (e instanceof McpError) throw new ConnectionError(400, e.message, "oauth");
    throw e;
  }
  const next: OAuthState = { ...o, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt, scope: tokens.scope, pending: null };
  const merged = { ...secrets, oauth: JSON.stringify(next) };
  const c = connectorById(row.connector);
  await db.update(connections).set({
    secrets: encryptSecrets(merged, id), status: "ok", statusDetail: null, nextRunAt: new Date(), updatedAt: new Date(),
    config: { ...(row.config ?? {}), authMode: "oauth" }, everyMinutes: c ? clampEvery(row.everyMinutes, c.manifest) : row.everyMinutes,
  }).where(eq(connections.id, id));
  void audit(v, "connections.signIn", { type: "connection", id }, { connector: row.connector }).catch(() => {});
  kick(id, v.graphId);
  return id;
}
