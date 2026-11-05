/**
 * The app's named limits (server-only), all counted by the shared limiter (`rate-limit.ts`) so they hold across server
 * processes and restarts. One place to see and tune them.
 */
import { limiter, type Limit, type RateLimiter, type Verdict } from "./rate-limit";

const MIN = 60_000;

export const LIMITS = {
  /** MCP server: requests a minute per key or connected app. */
  mcp: { bucket: "mcp", limit: 120, windowMs: MIN },
  /** Dictation (speech to text through mux): per person. */
  transcribe: { bucket: "transcribe", limit: 30, windowMs: MIN },
  /** Paste into the library (a web page is fetched for a link): per person. */
  paste: { bucket: "paste", limit: 40, windowMs: 10 * MIN },
  /** Imports sent as JSON (the iPhone app, the Mac helper): per person. */
  import: { bucket: "import", limit: 30, windowMs: 10 * MIN },
  /** Failed sign-ins per IP + account. */
  loginIp: { bucket: "login.ip", limit: 5, windowMs: 15 * MIN },
  /** Failed sign-ins per account across every IP (X-Forwarded-For can be spoofed; this can't be dodged that way). */
  loginAccount: { bucket: "login.account", limit: 20, windowMs: 15 * MIN },
  /** Approval cards for MCP tools that write, minted per person (each is single-use; this stops a loop minting them). */
  mcpApprovals: { bucket: "mcp.approvals", limit: 60, windowMs: 10 * MIN },
} as const satisfies Record<string, Limit>;

export type LimitName = keyof typeof LIMITS;

/** Count one request against a named limit. */
export function hit(name: LimitName, key: string, l: RateLimiter = limiter()): Promise<Verdict> {
  return l.hit(LIMITS[name], key);
}

/**
 * A drop-in for the old in-memory `AttemptLimiter` (sign-in): `check` first, `fail` on a wrong password, `reset` on
 * success. Async, and shared by every process.
 */
export class SharedAttemptLimiter {
  constructor(private readonly name: LimitName, private readonly l: () => RateLimiter = limiter) {}
  async check(key: string): Promise<{ allowed: true } | { allowed: false; retryAfterSec: number }> {
    const v = await this.l().check(LIMITS[this.name], key);
    return v.allowed ? { allowed: true } : v;
  }
  fail(key: string): Promise<void> { return this.l().fail(LIMITS[this.name], key); }
  reset(key: string): Promise<void> { return this.l().reset(LIMITS[this.name], key); }
}

export const sharedLoginLimiter = new SharedAttemptLimiter("loginIp");
export const sharedAccountLimiter = new SharedAttemptLimiter("loginAccount");
