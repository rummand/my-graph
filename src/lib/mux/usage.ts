/**
 * Token accounting for mux calls (server-only). Every chat completion reports what it cost — prompt, completion and
 * cached prompt tokens (mux passes the model's `usage` through; llama.cpp's prompt cache shows as `cached_tokens`) —
 * with the model, route and agent. Calls are logged at debug (`MG_DEBUG_TOKENS=1`) and collected per unit of work
 * with `meterUsage()`: a chat turn sums its rounds, title and tool plan from what was collected while it ran.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type MuxUsage = { promptTokens: number; completionTokens: number; cachedTokens: number };

export type UsageRecord = {
  agent: string; route: string | null; model: string | null; requestId: string | null;
  usage: MuxUsage | null; ms: number;
};

export type UsageTotals = MuxUsage & { calls: number; unreported: number; byAgent: Record<string, MuxUsage & { calls: number }> };

/** OpenAI-shaped `usage` → our shape; null when the model didn't say. Pure. */
export function readUsage(raw: unknown): MuxUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as { prompt_tokens?: unknown; completion_tokens?: unknown; prompt_tokens_details?: { cached_tokens?: unknown } | null; cache_read_input_tokens?: unknown };
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : 0);
  if (typeof u.prompt_tokens !== "number" && typeof u.completion_tokens !== "number") return null;
  return {
    promptTokens: n(u.prompt_tokens),
    completionTokens: n(u.completion_tokens),
    cachedTokens: n(u.prompt_tokens_details?.cached_tokens) || n(u.cache_read_input_tokens),
  };
}

/** Sum a list of calls (pure). */
export function sumUsage(records: UsageRecord[]): UsageTotals {
  const out: UsageTotals = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, calls: 0, unreported: 0, byAgent: {} };
  for (const r of records) {
    out.calls++;
    const a = (out.byAgent[r.agent] ??= { promptTokens: 0, completionTokens: 0, cachedTokens: 0, calls: 0 });
    a.calls++;
    if (!r.usage) { out.unreported++; continue; }
    out.promptTokens += r.usage.promptTokens; out.completionTokens += r.usage.completionTokens; out.cachedTokens += r.usage.cachedTokens;
    a.promptTokens += r.usage.promptTokens; a.completionTokens += r.usage.completionTokens; a.cachedTokens += r.usage.cachedTokens;
  }
  return out;
}

const store = new AsyncLocalStorage<UsageRecord[]>();

/** Note one finished call: logged at debug, and added to the work being metered (if any). */
export function noteUsage(rec: UsageRecord): void {
  store.getStore()?.push(rec);
  if (process.env.MG_DEBUG_TOKENS) {
    const u = rec.usage;
    console.log(`[mux:tokens] ${rec.agent} route=${rec.route ?? "?"} model=${rec.model ?? "?"} ${u ? `prompt=${u.promptTokens} cached=${u.cachedTokens} completion=${u.completionTokens}` : "usage=?"} ${rec.ms}ms`);
  }
}

/**
 * Run `fn` and collect every mux call made inside it (also in async work it starts, while that runs). The list is
 * live: read it whenever (e.g. at the end of a streamed turn).
 */
export function meterUsage<T>(fn: (calls: UsageRecord[]) => T): T {
  const calls: UsageRecord[] = [];
  return store.run(calls, () => fn(calls));
}
