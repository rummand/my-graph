/**
 * Rate limits for the MCP server: 120 requests a minute per key or connected app, counted in Postgres by the shared
 * limiter (src/lib/security), so the limit holds across restarts and server processes; past it, 429 with when to try
 * again. `ask` (a model call) is metered separately, per day, from the audit log (see deps.ts).
 */
import { LIMITS } from "@/lib/security/limits";
import { limiter, type RateLimiter } from "@/lib/security/rate-limit";

export const PER_MINUTE = LIMITS.mcp.limit;
/** Questions to the assistant a key or app may ask in 24 hours (MCP_ASK_PER_DAY overrides). */
export function askPerDay(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.MCP_ASK_PER_DAY);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 50;
}

/** Seconds to wait, or null when the request may go ahead. */
export async function rateLimited(id: string, l: RateLimiter = limiter()): Promise<number | null> {
  const v = await l.hit(LIMITS.mcp, `cred|${id}`);
  return v.allowed ? null : v.retryAfterSec;
}
