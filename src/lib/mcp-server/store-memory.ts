/** The MCP store in memory, for the tests (and nothing else). */
import type { ClientRow, CodeRow, GrantRow, KeyRow, McpStore, TokenRow } from "./types";

export function memoryStore(opts: {
  users?: Record<string, { active: boolean }>;
  /** userId → graphId → access */
  graphs?: Record<string, Record<string, { name: string; canWrite: boolean }>>;
} = {}): McpStore & { tables: { clients: ClientRow[]; codes: CodeRow[]; grants: GrantRow[]; tokens: TokenRow[]; keys: KeyRow[] } } {
  const tables = { clients: [] as ClientRow[], codes: [] as CodeRow[], grants: [] as GrantRow[], tokens: [] as TokenRow[], keys: [] as KeyRow[] };
  return {
    tables,
    async insertClient(r) { tables.clients.push({ ...r }); },
    async client(id) { return tables.clients.find((c) => c.id === id) ?? null; },
    async insertCode(r) { tables.codes.push({ ...r }); },
    async code(h) { return tables.codes.find((c) => c.codeHash === h) ?? null; },
    async spendCode(h, grantId, now) {
      const c = tables.codes.find((x) => x.codeHash === h && !x.usedAt);
      if (!c) return false;
      c.usedAt = now; c.grantId = grantId;
      return true;
    },
    async sweepCodes(before) { tables.codes = tables.codes.filter((c) => c.expiresAt >= before); },
    async insertGrant(r) { tables.grants.push({ ...r }); },
    async grant(id) { return tables.grants.find((g) => g.id === id) ?? null; },
    async liveGrants(userId, clientId) { return tables.grants.filter((g) => g.userId === userId && !g.revokedAt && (!clientId || g.clientId === clientId)); },
    async endGrant(id, now) {
      for (const g of tables.grants) if (g.id === id && !g.revokedAt) g.revokedAt = now;
      for (const t of tables.tokens) if (t.grantId === id && !t.revokedAt) t.revokedAt = now;
    },
    async touchGrant(id, now) { const g = tables.grants.find((x) => x.id === id); if (g) g.lastUsedAt = now; },
    async insertTokens(rows) { tables.tokens.push(...rows.map((r) => ({ ...r }))); },
    async tokenByHash(h) { return tables.tokens.find((t) => t.tokenHash === h) ?? null; },
    async spendToken(id, now) {
      const t = tables.tokens.find((x) => x.id === id && !x.revokedAt);
      if (!t) return false;
      t.revokedAt = now;
      return true;
    },
    async hasLiveToken(grantId, now) { return tables.tokens.some((t) => t.grantId === grantId && !t.revokedAt && t.expiresAt > now); },
    async insertKey(r) { tables.keys.push({ ...r }); },
    async keyByHash(h) { return tables.keys.find((k) => k.tokenHash === h) ?? null; },
    async liveKeys(userId) { return tables.keys.filter((k) => k.userId === userId && !k.revokedAt); },
    async revokeKey(userId, id, now) {
      const k = tables.keys.find((x) => x.id === id && x.userId === userId && !x.revokedAt);
      if (!k) return null;
      k.revokedAt = now;
      return k;
    },
    async touchKey(id, now) { const k = tables.keys.find((x) => x.id === id); if (k) k.lastUsedAt = now; },
    async userActive(userId) { return opts.users?.[userId]?.active ?? true; },
    async graphAccess(userId, graphId) { return opts.graphs?.[userId]?.[graphId] ?? null; },
  };
}
