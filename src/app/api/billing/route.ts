import { NextResponse } from "next/server";
import { requireUserApi } from "@/lib/auth";
import { billingSummary } from "@/lib/billing";
import { billingHandle } from "@/lib/billing/http";

/** GET: the signed-in person's own billing status (no Stripe ids, no card data). */
export async function GET() {
  return billingHandle(async () => {
    const v = await requireUserApi();
    return NextResponse.json(await billingSummary(v), { headers: { "cache-control": "no-store" } });
  });
}
