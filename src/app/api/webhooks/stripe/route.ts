import { NextResponse } from "next/server";
import { parseEvent, processEvent } from "@/lib/billing/events";
import { verifySignature } from "@/lib/billing/signature";
import { pgBillingStore } from "@/lib/billing/store";
import { stripeClient } from "@/lib/billing/stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 512 * 1024;

/**
 * Stripe webhook. No session and no origin check (middleware lets this path through): the signature on the raw body,
 * made with STRIPE_WEBHOOK_SECRET, is the authentication. Each event is processed once by its id; a failure answers
 * 500 so Stripe retries it. Event bodies, signatures and secrets are never logged.
 */
export async function POST(req: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) return NextResponse.json({ error: "Payments aren't set up yet." }, { status: 503 });
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BODY) return NextResponse.json({ error: "That request is too large." }, { status: 413 });
  const raw = await req.text();
  if (raw.length > MAX_BODY) return NextResponse.json({ error: "That request is too large." }, { status: 413 });

  const sig = verifySignature({ payload: raw, header: req.headers.get("stripe-signature"), secret });
  if (!sig.ok) return NextResponse.json({ error: "The signature didn't check out." }, { status: 400 });
  const event = parseEvent(raw);
  if (!event) return NextResponse.json({ error: "That isn't a Stripe event." }, { status: 400 });

  try {
    const r = await processEvent(pgBillingStore, event, { client: process.env.STRIPE_SECRET_KEY ? stripeClient() : null });
    // "busy": another delivery of the same event is being processed right now; ask Stripe to try again later.
    if (r.outcome === "busy") return NextResponse.json({ error: "Already being processed." }, { status: 409 });
    return NextResponse.json({ received: true, outcome: r.outcome });
  } catch (err) {
    console.error("[billing] webhook", event.type, event.id, err instanceof Error ? err.message : "failed");
    return NextResponse.json({ error: "We couldn't process that event. Stripe will retry it." }, { status: 500 });
  }
}
