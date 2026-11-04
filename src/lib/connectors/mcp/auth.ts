/**
 * The bearer token for an MCP connection (server-only): its API key, or its OAuth access token, refreshed when it is
 * about to end. A refresh rotates the refresh token (Record ends the whole sign-in if a spent one comes back), so
 * refreshes of one connection are serialised in this process and the newest saved sign-in is re-read before each.
 * The new tokens are written back encrypted right away.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { connections } from "@/db/schema";
import { McpError } from "@/lib/mcp-client/errors";
import { needsRefresh, refreshTokens } from "@/lib/mcp-client/oauth";
import { guardedTransport, type Transport } from "@/lib/mcp-client/transport";
import { decryptSecrets, encryptSecrets } from "../crypto";
import { needsYou } from "../errors";
import { readOAuth, type OAuthState } from "./config";

const g = globalThis as unknown as { __mgMcpRefresh?: Map<string, Promise<string>> };
const inflight = (g.__mgMcpRefresh ??= new Map());

export const signInAgain = () => needsYou("The sign-in has ended. Sign in again to keep it connected.", "signIn");

/**
 * The token to send. `secrets` is updated in place when tokens are refreshed (so a running sync keeps the new ones).
 */
export async function bearerFor(conn: { id: string; config: { authMode?: string } }, secrets: Record<string, string>, transport: Transport = guardedTransport()): Promise<string | null> {
  const mode = conn.config.authMode ?? "key";
  if (mode === "none") return null;
  if (mode === "key") {
    if (!secrets.apiKey) throw needsYou("Paste an API key for this server.", "missingKey");
    return secrets.apiKey;
  }
  const o = readOAuth(secrets);
  if (!o?.accessToken) throw needsYou("Sign in to the server to connect it.", "signIn");
  if (!needsRefresh({ expiresAt: o.expiresAt ?? null })) return o.accessToken;
  if (!o.refreshToken) throw signInAgain();

  const running = inflight.get(conn.id);
  if (running) return running;
  const p = (async () => {
    // Someone else in this process may have refreshed already: start from what is saved now.
    const [row] = await db.select({ secrets: connections.secrets }).from(connections).where(eq(connections.id, conn.id)).limit(1);
    if (!row) throw needsYou("This connection was disconnected.", "disconnected");
    const saved = decryptSecrets(row.secrets, conn.id);
    const cur = readOAuth(saved) ?? o;
    if (cur.accessToken && !needsRefresh({ expiresAt: cur.expiresAt ?? null })) {
      Object.assign(secrets, saved);
      return cur.accessToken;
    }
    if (!cur.refreshToken) throw signInAgain();
    let t;
    try {
      t = await refreshTokens(transport, cur.tokenEndpoint, { clientId: cur.clientId, clientSecret: cur.clientSecret ?? null }, cur.refreshToken, cur.resource);
    } catch (e) {
      if (e instanceof McpError && e.code === "oauth" && (e.extra.status === 400 || e.extra.status === 401)) throw signInAgain();
      throw e;
    }
    const next: OAuthState = { ...cur, accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt, scope: t.scope ?? cur.scope ?? null, pending: null };
    const merged = { ...saved, oauth: JSON.stringify(next) };
    await db.update(connections).set({ secrets: encryptSecrets(merged, conn.id), updatedAt: new Date() }).where(eq(connections.id, conn.id));
    Object.assign(secrets, merged);
    return t.accessToken;
  })().finally(() => inflight.delete(conn.id));
  inflight.set(conn.id, p);
  return p;
}
