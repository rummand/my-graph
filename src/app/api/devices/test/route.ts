import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { deliverPush, pushSender } from "@/lib/push";
import { handle, jsonError } from "@/lib/push/http";

export const dynamic = "force-dynamic";

/** POST /api/devices/test: sends "Notifications work on this iPhone." to this person's devices (owner setup check). */
export function POST() {
  return handle(async () => {
    const v = await requireUser();
    const sender = pushSender();
    if (!sender) return jsonError(503, "Push isn't set up on this server yet. The app still shows reminders on its own.");
    const r = await deliverPush(sender, v.id, { kind: "test" }, `test:${Date.now()}`);
    if (!r.sent) {
      const msg = r.reason === "no_device" ? "No iPhone is registered for notifications on this account yet." : "The test notification couldn't be sent. Try again in a moment.";
      return jsonError(r.reason === "no_device" ? 404 : 502, msg);
    }
    return NextResponse.json({ ok: true });
  });
}
