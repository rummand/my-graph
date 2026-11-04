/**
 * Who may open the platform admin console, and the request checks every admin route runs (pure, for tests).
 * Anyone who isn't a platform admin, signed in or not, gets a plain 404: the console doesn't exist for them.
 */
import { isAllowedOrigin, type OriginInput } from "@/lib/security/origin";
import { AttemptLimiter } from "@/lib/auth/rate-limit";
import { emailIsAdmin } from "./catalog";

export type AdminGate = { ok: true } | { ok: false; status: 404 | 403 | 429; error: string; retryAfterSec?: number };

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
export const NOT_FOUND = "Not found.";

export function adminGate(i: {
  viewer: { id: string; email: string } | null;
  admins: string[];
  method: string;
  origin: OriginInput;
  limiter: AttemptLimiter;
}): AdminGate {
  if (!i.viewer || !emailIsAdmin(i.viewer.email, i.admins)) return { ok: false, status: 404, error: NOT_FOUND };
  if (!SAFE.has(i.method.toUpperCase()) && !isAllowedOrigin(i.origin)) {
    return { ok: false, status: 403, error: "This request came from another site and was blocked." };
  }
  const key = `admin|${i.viewer.id}|${SAFE.has(i.method.toUpperCase()) ? "read" : "write"}`;
  const c = i.limiter.check(key);
  if (!c.allowed) return { ok: false, status: 429, error: "Too many admin requests. Wait a moment and try again.", retryAfterSec: c.retryAfterSec };
  i.limiter.fail(key); // every request counts toward the window
  return { ok: true };
}

const g = globalThis as unknown as { __mgAdminLimiter?: AttemptLimiter };
/** 60 requests a minute per admin (reads and writes counted separately). */
export const adminLimiter = g.__mgAdminLimiter ?? (g.__mgAdminLimiter = new AttemptLimiter(60, 60 * 1000));
