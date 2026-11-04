/** The MCP store on Postgres (server-only). Spends are single-row UPDATE … WHERE not yet spent … RETURNING. */
import { and, desc, eq, gt, isNull, lt } from "drizzle-orm";
import { db } from "@/db";
import { mcpClients, mcpCodes, mcpGrants, mcpKeys, mcpTokens, users } from "@/db/schema";
import { isLocked } from "@/lib/auth/account-controls";
import { signInBlocked } from "@/lib/auth/store";
import { viewerFor } from "@/lib/auth/viewer-for";
import { scopeOf } from "@/lib/graphs/pure";
import type { ClientRow, CodeRow, GrantRow, KeyRow, McpStore, Scope, TokenRow } from "./types";

const scope = (s: string): Scope => (s === "propose" ? "propose" : "read");
const asClient = (r: typeof mcpClients.$inferSelect): ClientRow => ({ ...r, authMethod: r.authMethod as ClientRow["authMethod"] });
const asCode = (r: typeof mcpCodes.$inferSelect): CodeRow => ({ ...r, scope: scope(r.scope) });
const asGrant = (r: typeof mcpGrants.$inferSelect): GrantRow => ({ ...r, scope: scope(r.scope) });
const asToken = (r: typeof mcpTokens.$inferSelect): TokenRow => ({ ...r, kind: r.kind === "refresh" ? "refresh" : "access" });
const asKey = (r: typeof mcpKeys.$inferSelect): KeyRow => ({ ...r, scope: scope(r.scope) });

export const dbStore: McpStore = {
  async insertClient(r) { await db.insert(mcpClients).values(r); },
  async client(id) { const [r] = await db.select().from(mcpClients).where(eq(mcpClients.id, id.slice(0, 100))); return r ? asClient(r) : null; },

  async insertCode(r) { await db.insert(mcpCodes).values(r); },
  async code(h) { const [r] = await db.select().from(mcpCodes).where(eq(mcpCodes.codeHash, h)); return r ? asCode(r) : null; },
  async spendCode(h, grantId, now) {
    const r = await db.update(mcpCodes).set({ usedAt: now, grantId }).where(and(eq(mcpCodes.codeHash, h), isNull(mcpCodes.usedAt))).returning({ h: mcpCodes.codeHash });
    return r.length === 1;
  },
  async sweepCodes(before) { await db.delete(mcpCodes).where(lt(mcpCodes.expiresAt, before)); },

  async insertGrant(r) { await db.insert(mcpGrants).values(r); },
  async grant(id) { const [r] = await db.select().from(mcpGrants).where(eq(mcpGrants.id, id)); return r ? asGrant(r) : null; },
  async liveGrants(userId, clientId) {
    const rows = await db.select().from(mcpGrants).where(and(eq(mcpGrants.userId, userId), isNull(mcpGrants.revokedAt), clientId ? eq(mcpGrants.clientId, clientId) : undefined)).orderBy(desc(mcpGrants.createdAt));
    return rows.map(asGrant);
  },
  async endGrant(id, now) {
    await db.transaction(async (tx) => {
      await tx.update(mcpGrants).set({ revokedAt: now }).where(and(eq(mcpGrants.id, id), isNull(mcpGrants.revokedAt)));
      await tx.update(mcpTokens).set({ revokedAt: now }).where(and(eq(mcpTokens.grantId, id), isNull(mcpTokens.revokedAt)));
    });
  },
  async touchGrant(id, now) { await db.update(mcpGrants).set({ lastUsedAt: now }).where(eq(mcpGrants.id, id)); },

  async insertTokens(rows) { await db.insert(mcpTokens).values(rows); },
  async tokenByHash(h) { const [r] = await db.select().from(mcpTokens).where(eq(mcpTokens.tokenHash, h)); return r ? asToken(r) : null; },
  async spendToken(id, now) {
    const r = await db.update(mcpTokens).set({ revokedAt: now }).where(and(eq(mcpTokens.id, id), isNull(mcpTokens.revokedAt))).returning({ id: mcpTokens.id });
    return r.length === 1;
  },
  async hasLiveToken(grantId, now) {
    const [r] = await db.select({ id: mcpTokens.id }).from(mcpTokens).where(and(eq(mcpTokens.grantId, grantId), isNull(mcpTokens.revokedAt), gt(mcpTokens.expiresAt, now))).limit(1);
    return !!r;
  },

  async insertKey(r) { await db.insert(mcpKeys).values(r); },
  async keyByHash(h) { const [r] = await db.select().from(mcpKeys).where(eq(mcpKeys.tokenHash, h)); return r ? asKey(r) : null; },
  async liveKeys(userId) {
    return (await db.select().from(mcpKeys).where(and(eq(mcpKeys.userId, userId), isNull(mcpKeys.revokedAt))).orderBy(desc(mcpKeys.createdAt))).map(asKey);
  },
  async revokeKey(userId, id, now) {
    const [r] = await db.update(mcpKeys).set({ revokedAt: now }).where(and(eq(mcpKeys.id, id), eq(mcpKeys.userId, userId), isNull(mcpKeys.revokedAt))).returning();
    return r ? asKey(r) : null;
  },
  async touchKey(id, now) { await db.update(mcpKeys).set({ lastUsedAt: now }).where(eq(mcpKeys.id, id)); },

  async userActive(userId) {
    const [u] = await db.select({ role: users.role, accessExpiresAt: users.accessExpiresAt }).from(users).where(eq(users.id, userId));
    if (!u || signInBlocked(u)) return false;
    return !(await isLocked(userId).catch(() => false));
  },
  async graphAccess(userId, graphId) {
    const v = await viewerFor(userId, graphId).catch(() => null);
    return v ? { name: v.graphName, canWrite: scopeOf(v).canWrite } : null;
  },
};
