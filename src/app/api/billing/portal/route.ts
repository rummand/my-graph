import { NextResponse } from "next/server";
import { z } from "zod";
import { audit, requireUserApi } from "@/lib/auth";
import { parseBody } from "@/lib/auth/http";
import { baseUrlFrom, openPortal } from "@/lib/billing";
import { billingHandle } from "@/lib/billing/http";
import { getLocale } from "@/lib/i18n";

/** POST {}: a Stripe Customer Portal page for changing plan or card, invoices and cancelling. Returns { url }. */
export async function POST(req: Request) {
  return billingHandle(async () => {
    const v = await requireUserApi();
    await parseBody(req, z.object({}).strict());
    const out = await openPortal(v, { baseUrl: baseUrlFrom(req), locale: await getLocale() });
    await audit(v, "billing.portal", { type: "user", id: v.id });
    return NextResponse.json(out);
  });
}
