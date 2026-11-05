/** Route-handler plumbing for /api/billing: billing and Stripe errors become JSON `{ error }` with a fitting status. */
import { handle } from "@/lib/auth/http";
import { errorJson } from "@/lib/auth/http";
import { BillingError } from "./index";
import { StripeError } from "./stripe";

export async function billingHandle(fn: () => Promise<Response>): Promise<Response> {
  return handle(async () => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof BillingError) return errorJson(e.status, e.message);
      if (e instanceof StripeError) {
        // Stripe's own message can name request details; keep it in the server log (no secrets are in it) and say less.
        console.error("[billing] stripe", e.status, e.type ?? "", e.code ?? "", e.message);
        return errorJson(e.status === 503 ? 503 : 502, e.status === 503 ? e.message : "The payment service didn't accept that. Try again in a moment.");
      }
      throw e;
    }
  });
}
