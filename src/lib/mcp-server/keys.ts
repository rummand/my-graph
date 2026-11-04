/**
 * Personal access keys for the MCP server: a person names a key, picks ONE graph and read or read and propose. The key
 * is shown once; only its SHA-256 hash and its first characters are kept. Sent as `Authorization: Bearer mgk_…`, it acts
 * as its person in that graph, never beyond their own rights there (checked again on every call).
 */
import { newKey, hashToken, isKeyToken } from "./tokens";
import type { Credential, KeyRow, McpStore, Scope } from "./types";

export const NAME_MAX = 60;
/** At most this many live keys a person; revoke one to make another. */
export const KEYS_MAX = 20;

export type KeyOut = { id: string; name: string; prefix: string; scope: Scope; graphId: string; createdAt: string; lastUsedAt: string | null };
const out = (k: KeyRow): KeyOut => ({ id: k.id, name: k.name, prefix: k.prefix, scope: k.scope, graphId: k.graphId, createdAt: k.createdAt.toISOString(), lastUsedAt: k.lastUsedAt?.toISOString() ?? null });

export class KeyError extends Error {
  constructor(readonly status: number, message: string, readonly code: string) { super(message); }
}

export async function listKeys(store: McpStore, userId: string): Promise<KeyOut[]> {
  return (await store.liveKeys(userId)).map(out);
}

export async function makeKey(store: McpStore, userId: string, input: { name: string; scope: Scope; graphId: string }, now = new Date()): Promise<{ key: string; out: KeyOut }> {
  const name = input.name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, NAME_MAX);
  if (!name) throw new KeyError(400, "Give the key a name, so you know later what uses it.", "nameMissing");
  const access = await store.graphAccess(userId, input.graphId);
  if (!access) throw new KeyError(404, "You're not in that graph.", "notMember");
  if (input.scope === "propose" && !access.canWrite) throw new KeyError(403, "You can only look at that graph, so a key for it can only read.", "cantWrite");
  if ((await store.liveKeys(userId)).length >= KEYS_MAX) throw new KeyError(409, `You have ${KEYS_MAX} keys. Revoke one you no longer use to make another.`, "tooMany");
  const k = newKey();
  const row: KeyRow = { id: crypto.randomUUID(), userId, graphId: input.graphId, name, prefix: k.prefix, tokenHash: k.hash, scope: input.scope, createdAt: now, lastUsedAt: null, revokedAt: null };
  await store.insertKey(row);
  return { key: k.token, out: out(row) };
}

export async function revokeKey(store: McpStore, userId: string, id: string, now = new Date()): Promise<KeyOut | null> {
  const k = await store.revokeKey(userId, id, now);
  return k ? out(k) : null;
}

const TOUCH_MS = 60_000;

/** The credential a key stands for, while it isn't revoked and its person may still use My Graph. */
export async function credentialForKey(store: McpStore, token: string, now = new Date()): Promise<Credential | null> {
  if (!isKeyToken(token)) return null;
  const k = await store.keyByHash(hashToken(token));
  if (!k || k.revokedAt) return null;
  if (!(await store.userActive(k.userId))) return null;
  if (!k.lastUsedAt || now.getTime() - k.lastUsedAt.getTime() > TOUCH_MS) await store.touchKey(k.id, now).catch(() => undefined);
  return { kind: "key", id: k.id, name: k.name, userId: k.userId, graphId: k.graphId, scope: k.scope };
}
