/**
 * The app side of provider tokens (server-only): saved secrets read and written through the connection row,
 * encrypted with the connection id as associated data, and an authorised `Api` for a run or a settings request.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { connections } from "@/db/schema";
import { guardedTransport, type Transport } from "@/lib/mcp-client/transport";
import { decryptSecrets, encryptSecrets } from "../crypto";
import { makeApi, type Api } from "./client";
import { providerInfo, providerOf, type ProviderId } from "./providers";
import { accessTokenFor, type SecretStore } from "./tokens";

export const dbSecretStore: SecretStore = {
  async load(id) {
    const [row] = await db.select({ secrets: connections.secrets }).from(connections).where(eq(connections.id, id)).limit(1);
    if (!row) return null;
    try { return decryptSecrets(row.secrets, id); } catch { return null; }
  },
  async save(id, secrets) {
    await db.update(connections).set({ secrets: encryptSecrets(secrets, id), updatedAt: new Date() }).where(eq(connections.id, id));
  },
};

export const WHO: Record<ProviderId, string> = { google: "Google", microsoft: "Microsoft", dropbox: "Dropbox", slack: "Slack", notion: "Notion", github: "GitHub", linear: "Linear" };

/** An authorised API for one connection. `secrets` is the decrypted map; refreshed tokens are merged into it. */
export function apiFor(conn: { id: string; connector: string }, secrets: Record<string, string>, opts: { signal?: AbortSignal; throttle?: () => Promise<void>; transport?: Transport; store?: SecretStore } = {}): Api {
  const provider = providerOf(conn.connector);
  if (!provider) throw new Error(`"${conn.connector}" doesn't sign in with a provider.`);
  const p = providerInfo(provider);
  const transport = opts.transport ?? guardedTransport();
  const store = opts.store ?? dbSecretStore;
  return makeApi({
    transport, signal: opts.signal, throttle: opts.throttle, who: WHO[provider],
    token: () => accessTokenFor(conn, secrets, p, transport, store, { signal: opts.signal }),
    refresh: () => accessTokenFor(conn, secrets, p, transport, store, { force: true, signal: opts.signal }),
  });
}
