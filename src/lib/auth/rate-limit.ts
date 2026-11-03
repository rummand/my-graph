/**
 * In-memory fixed-window limiter for sign-in attempts (per IP + account). Single-process by design: My Graph runs
 * as one Node server. Failed attempts count; a successful sign-in clears the key.
 */
export type Clock = () => number;

export class AttemptLimiter {
  private hits = new Map<string, number[]>();
  constructor(private max = 5, private windowMs = 15 * 60 * 1000, private now: Clock = Date.now) {}

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  /** Whether another attempt is allowed now, and if not, how many seconds until it is. */
  check(key: string): { allowed: true } | { allowed: false; retryAfterSec: number } {
    const list = this.recent(key);
    if (list.length < this.max) return { allowed: true };
    const retry = Math.ceil((list[0] + this.windowMs - this.now()) / 1000);
    return { allowed: false, retryAfterSec: Math.max(1, retry) };
  }

  fail(key: string): void {
    const list = this.recent(key);
    list.push(this.now());
    this.hits.set(key, list);
    if (this.hits.size > 10_000) this.sweep();
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private sweep() {
    for (const key of [...this.hits.keys()]) this.recent(key);
  }
}

export function attemptKey(ip: string, identifier: string): string {
  return `${ip}|${identifier.trim().toLowerCase()}`;
}

/** Client IP from proxy headers (Railway sets x-forwarded-for; the first entry is the client). */
export function clientIp(h: { get(name: string): string | null }): string {
  const xff = h.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return h.get("x-real-ip")?.trim() || "unknown";
}

/**
 * Per-account key, independent of the client IP. X-Forwarded-For is client-controlled (a proxy appends to it rather
 * than replacing it), so an attacker can rotate the "IP" on every request; this limit still holds.
 */
export function accountKey(identifier: string): string {
  return `acct|${identifier.trim().toLowerCase()}`;
}

const g = globalThis as unknown as { __mgLoginLimiter?: AttemptLimiter; __mgAccountLimiter?: AttemptLimiter };
/** Shared limiter for password and passkey sign-in (per IP + account). */
export const loginLimiter = g.__mgLoginLimiter ?? (g.__mgLoginLimiter = new AttemptLimiter());
/** Per-account limiter across all IPs: looser than the per-IP one, but can't be dodged by spoofing headers. */
export const accountLimiter = g.__mgAccountLimiter ?? (g.__mgAccountLimiter = new AttemptLimiter(20, 15 * 60 * 1000));
