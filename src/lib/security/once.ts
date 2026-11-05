/**
 * One-time tokens (server-only): "this approval has been used" recorded in Postgres (`used_approvals`) so it holds
 * across restarts and across server processes, with an in-memory set in front as a cache. Only a hash of the token is
 * stored, until the moment the token would have expired anyway; expired rows are swept on use.
 *
 * When the database can't be reached, the in-memory set decides (the token is still bound to the person, tool and
 * arguments by its signature, so the worst case is the old per-process behaviour, never an unbound call).
 */
import { createHash } from "node:crypto";
import { lt } from "drizzle-orm";
import { db } from "@/db";
import { usedApprovals } from "@/db/schema";

export interface OnceStore {
  /** Record the hash; true when it was not recorded before. */
  claim(hash: string, kind: string, userId: string | null, expiresAt: number): Promise<boolean>;
  sweep(now: number): Promise<void>;
}

export function memoryOnceStore(): OnceStore & { size(): number } {
  const m = new Map<string, number>();
  return {
    async claim(hash, _kind, _user, exp) {
      if (m.has(hash)) return false;
      m.set(hash, exp);
      return true;
    },
    async sweep(now) {
      for (const [k, exp] of m) if (exp <= now) m.delete(k);
    },
    size: () => m.size,
  };
}

export const dbOnceStore: OnceStore = {
  async claim(hash, kind, userId, expiresAt) {
    const r = await db.insert(usedApprovals).values({ tokenHash: hash, kind, userId, expiresAt: new Date(expiresAt) })
      .onConflictDoNothing({ target: usedApprovals.tokenHash }).returning({ h: usedApprovals.tokenHash });
    return r.length > 0;
  },
  async sweep(now) {
    await db.delete(usedApprovals).where(lt(usedApprovals.expiresAt, new Date(now)));
  },
};

export const tokenHash = (kind: string, token: string) => createHash("sha256").update(`mg-once|${kind}|${token}`).digest("base64url");

export class OneTimeTokens {
  private readonly local = memoryOnceStore();
  private lastSweep = 0;
  constructor(private readonly store: OnceStore = dbOnceStore, private readonly onStoreError: (e: unknown) => void = (e) => console.warn("[once] database unavailable, remembering in memory:", e instanceof Error ? e.message : e)) {}

  /**
   * Use a token once. True the first time (anywhere, any process), false after. `expiresAt` is when the token stops
   * being valid on its own; the record is kept until then.
   */
  async spend(kind: string, token: string, expiresAt: number, userId: string | null = null, now = Date.now()): Promise<boolean> {
    const h = tokenHash(kind, token);
    if (now - this.lastSweep > 5 * 60_000) {
      this.lastSweep = now;
      void this.local.sweep(now);
      void this.store.sweep(now).catch(() => {});
    }
    // Seen here already: no need to ask.
    if (!(await this.local.claim(h, kind, userId, expiresAt))) return false;
    try {
      return await this.store.claim(h, kind, userId, expiresAt);
    } catch (e) {
      this.onStoreError(e);
      return true; // first time in this process, and the database can't say otherwise
    }
  }
}

const g = globalThis as unknown as { __mgOnce?: OneTimeTokens };
export function oneTimeTokens(): OneTimeTokens {
  return (g.__mgOnce ??= new OneTimeTokens());
}
