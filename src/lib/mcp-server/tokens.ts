/**
 * Secrets the MCP server hands out, pure: random, prefixed so a person (and a secret scanner) can tell them apart, and
 * kept only as SHA-256 hashes. A key is shown once; nobody, My Graph included, can show it again.
 *
 *   mgk_  personal access key        mga_  OAuth access token (an hour)     mgr_  OAuth refresh token (30 days)
 *   mgc_  OAuth code (ten minutes)   mgs_  client secret                     mgcl_ client id (not secret)
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const KEY_PREFIX = "mgk_", ACCESS_PREFIX = "mga_", REFRESH_PREFIX = "mgr_", CODE_PREFIX = "mgc_", SECRET_PREFIX = "mgs_", CLIENT_PREFIX = "mgcl_";

export const random = (prefix: string, bytes = 32) => `${prefix}${randomBytes(bytes).toString("base64url")}`;

/** SHA-256, hex. Tokens carry 256 random bits, so a fast hash is the right one (nothing to brute-force). */
export const hashToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

/** Constant-time comparison of two hashes. */
export function sameHash(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** A new personal access key: the key itself (shown once), what is kept (its hash) and how it is told apart. */
export function newKey(): { token: string; hash: string; prefix: string } {
  const token = random(KEY_PREFIX);
  return { token, hash: hashToken(token), prefix: `${token.slice(0, 10)}…` };
}

/** Looks like one of ours (cheap check before any database read). */
export const isKeyToken = (t: string) => t.startsWith(KEY_PREFIX) && t.length >= 40 && t.length <= 120;
export const isAccessToken = (t: string) => t.startsWith(ACCESS_PREFIX) && t.length >= 40 && t.length <= 120;
export const isOAuthToken = (t: string) => isAccessToken(t) || (t.startsWith(REFRESH_PREFIX) && t.length <= 120);

/** PKCE (RFC 7636), S256 only: the verifier hashes to the challenge. */
export function verifierMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  return sameHash(createHash("sha256").update(verifier).digest("base64url"), challenge);
}

export const challengeOk = (c: string | undefined) => !!c && /^[A-Za-z0-9._~-]{43,128}$/.test(c);

/** The `Authorization: Bearer …` token of a request ("" when there is none). Never read from the address. */
export const bearerOf = (h: string | null | undefined) => h?.match(/^Bearer\s+(\S+)\s*$/i)?.[1] ?? "";
