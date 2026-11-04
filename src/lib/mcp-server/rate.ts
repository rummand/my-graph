/**
 * Rate limits for the MCP server, in this process (My Graph runs as one): 120 requests a minute per key or connected
 * app; past it, 429 with when to try again. A restart forgets the count, which errs on the person's side. `ask` (a model
 * call) is metered separately, per day, from the audit log (see http.ts).
 */
export const PER_MINUTE = 120;
/** Questions to the assistant a key or app may ask in 24 hours (MCP_ASK_PER_DAY overrides). */
export function askPerDay(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.MCP_ASK_PER_DAY);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 50;
}

const windows = new Map<string, { start: number; n: number }>();

/** Seconds to wait, or null when the request may go ahead. */
export function rateLimited(id: string, now = Date.now(), limit = PER_MINUTE): number | null {
  const w = windows.get(id);
  if (!w || now - w.start >= 60_000) {
    windows.set(id, { start: now, n: 1 });
    if (windows.size > 10_000) for (const [k, v] of windows) if (now - v.start >= 60_000) windows.delete(k);
    return null;
  }
  w.n++;
  return w.n > limit ? Math.max(1, Math.ceil((w.start + 60_000 - now) / 1000)) : null;
}
