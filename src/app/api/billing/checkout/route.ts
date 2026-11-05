import { NextResponse } from "next/server";
import { z } from "zod";
import { audit, requireUserApi } from "@/lib/auth";
import { parseBody } from "@/lib/auth/http";
import { baseUrlFrom, startCheckout } from "@/lib/billing";
import { billingHandle } from "@/lib/billing/http";
import { getLocale } from "@/lib/i18n";

const Body = z.object({
  plan: z.string().trim().min(1, "Choose a plan.").max(40),
  interval: z.enum(["month", "year"], { message: "Choose monthly or yearly." }),
}).strict();

/** POST { plan, interval }: a Stripe Checkout page for one of the public paid plans. Returns { url } to go to. */
export async function POST(req: Request) {
  return billingHandle(async () => {
    const v = await requireUserApi();
    const body = await parseBody(req, Body);
    const out = await startCheckout(v, { ...body, baseUrl: baseUrlFrom(req), locale: await getLocale() });
    await audit(v, "billing.checkout", { type: "user", id: v.id }, { plan: body.plan, interval: body.interval });
    return NextResponse.json(out);
  });
}
