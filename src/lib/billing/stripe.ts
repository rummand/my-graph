/**
 * A small Stripe REST client over fetch (no SDK). Server-only. The secret key is read from the environment at call
 * time, sent only in the Authorization header to Stripe, and never logged or returned: errors carry Stripe's message
 * and type, nothing from the request.
 */
import type { BillingEnv } from "./config";

export type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean; status: number; json: () => Promise<unknown>;
}>;

export class StripeError extends Error {
  constructor(public status: number, message: string, public type?: string, public code?: string) {
    super(message);
    this.name = "StripeError";
  }
}

type Param = string | number | boolean | null | undefined | Param[] | { [k: string]: Param };

/** Stripe's form encoding: nested objects and arrays as `a[b][0][c]=…`. Null and undefined are left out. */
export function encodeForm(params: Record<string, Param>): string {
  const out: string[] = [];
  const walk = (key: string, v: Param) => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(`${key}[${i}]`, x));
    else if (typeof v === "object") for (const [k, x] of Object.entries(v)) walk(`${key}[${k}]`, x);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  };
  for (const [k, v] of Object.entries(params)) walk(k, v);
  return out.join("&");
}

export type StripeClient = {
  request<T = Record<string, unknown>>(method: "GET" | "POST" | "DELETE", path: string, params?: Record<string, Param>, opts?: { idempotencyKey?: string }): Promise<T>;
};

/** Stripe API version this code is written against (the request pins it, so dashboard upgrades don't change shapes). */
export const STRIPE_API_VERSION = "2024-06-20";

export function stripeClient(env: BillingEnv = process.env, fetchImpl: FetchLike = fetch as unknown as FetchLike): StripeClient {
  return {
    async request(method, path, params, opts) {
      const key = env.STRIPE_SECRET_KEY?.trim();
      if (!key) throw new StripeError(503, "Payments aren't set up yet.");
      const base = (env.STRIPE_API_BASE?.trim() || "https://api.stripe.com").replace(/\/$/, "");
      const form = params ? encodeForm(params) : "";
      const url = `${base}${path}${method === "GET" && form ? `?${form}` : ""}`;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${key}`,
        "Stripe-Version": STRIPE_API_VERSION,
      };
      if (method !== "GET") headers["Content-Type"] = "application/x-www-form-urlencoded";
      if (opts?.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
      let res: Awaited<ReturnType<FetchLike>>;
      try {
        res = await fetchImpl(url, { method, headers, body: method === "GET" ? undefined : form, signal: AbortSignal.timeout(20_000) });
      } catch {
        throw new StripeError(502, "We couldn't reach the payment service. Try again in a moment.");
      }
      let data: Record<string, unknown> = {};
      try { data = (await res.json()) as Record<string, unknown>; } catch { /* empty */ }
      if (!res.ok) {
        const err = (data.error ?? {}) as { message?: string; type?: string; code?: string };
        throw new StripeError(res.status, err.message ?? `The payment service answered ${res.status}.`, err.type, err.code);
      }
      return data as never;
    },
  };
}
