/** Shared types of the MCP server (no runtime code). */

/** What a person allows: read the graph, or read it and propose changes (a change set they deliver themselves). */
export type Scope = "read" | "propose";
export const SCOPES: Scope[] = ["read", "propose"];

/** Who is calling: a personal access key or an app connected by OAuth. Always one person in one graph. */
export type Credential = { kind: "key" | "app"; id: string; name: string; userId: string; graphId: string; scope: Scope };

export type ClientRow = { id: string; name: string; uri: string | null; redirectUris: string[]; authMethod: AuthMethod; secretHash: string | null; createdAt: Date };
export type CodeRow = {
  codeHash: string; clientId: string; userId: string; graphId: string; scope: Scope; resource: string; redirectUri: string;
  challenge: string; expiresAt: Date; usedAt: Date | null; grantId: string | null;
};
export type GrantRow = { id: string; userId: string; clientId: string; graphId: string; scope: Scope; resource: string; createdAt: Date; lastUsedAt: Date | null; revokedAt: Date | null };
export type TokenRow = { id: string; grantId: string; kind: "access" | "refresh"; tokenHash: string; expiresAt: Date; revokedAt: Date | null };
export type KeyRow = { id: string; userId: string; graphId: string; name: string; prefix: string; tokenHash: string; scope: Scope; createdAt: Date; lastUsedAt: Date | null; revokedAt: Date | null };

export const AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

/**
 * Everything the OAuth server and the keys keep, behind one interface: the database in the app (store-db.ts), memory
 * in the tests (store-memory.ts). Every "spend" is atomic: it succeeds for exactly one caller.
 */
export interface McpStore {
  insertClient(row: ClientRow): Promise<void>;
  client(id: string): Promise<ClientRow | null>;

  insertCode(row: CodeRow): Promise<void>;
  code(hash: string): Promise<CodeRow | null>;
  /** Mark a code used (only if it wasn't yet). True for the one caller that spent it. */
  spendCode(hash: string, grantId: string, now: Date): Promise<boolean>;
  sweepCodes(before: Date): Promise<void>;

  insertGrant(row: GrantRow): Promise<void>;
  grant(id: string): Promise<GrantRow | null>;
  liveGrants(userId: string, clientId?: string): Promise<GrantRow[]>;
  /** End a grant and every token of it. */
  endGrant(id: string, now: Date): Promise<void>;
  touchGrant(id: string, now: Date): Promise<void>;

  insertTokens(rows: TokenRow[]): Promise<void>;
  tokenByHash(hash: string): Promise<TokenRow | null>;
  /** Revoke one token (only if it wasn't yet). True for the one caller that revoked it. */
  spendToken(id: string, now: Date): Promise<boolean>;
  hasLiveToken(grantId: string, now: Date): Promise<boolean>;

  insertKey(row: KeyRow): Promise<void>;
  keyByHash(hash: string): Promise<KeyRow | null>;
  liveKeys(userId: string): Promise<KeyRow[]>;
  revokeKey(userId: string, id: string, now: Date): Promise<KeyRow | null>;
  touchKey(id: string, now: Date): Promise<void>;

  /** The person may still use My Graph (exists, not locked, guest access not ended). */
  userActive(userId: string): Promise<boolean>;
  /** The person's place in a graph today: null when they are not a member (or it is archived). */
  graphAccess(userId: string, graphId: string): Promise<{ name: string; canWrite: boolean } | null>;
}
