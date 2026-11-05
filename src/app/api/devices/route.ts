import { NextResponse } from "next/server";
import { audit, getSession, requireUser } from "@/lib/auth";
import { listDevices, registerDevice, unregisterDevice } from "@/lib/push";
import { firstIssue, handle, jsonError, pushStatus, readJson, registerSchema, unregisterSchema } from "@/lib/push/http";

export const dynamic = "force-dynamic";

async function sessionId(): Promise<string | null> {
  const s = await getSession();
  return s.status === "active" ? s.sessionId : null;
}

/** GET /api/devices: this person's devices (no tokens) and whether the server pushes. */
export function GET() {
  return handle(async () => {
    const v = await requireUser();
    const devices = await listDevices(v.id, await sessionId());
    return NextResponse.json({ devices, ...(await pushStatus(v)) });
  });
}

/**
 * POST /api/devices { token, platform: "ios", environment?, appVersion?, locale? }: the iPhone app calls this after
 * sign-in once notifications are allowed (and on every start, which refreshes "last seen"). Answers whether the
 * server pushes reminders, so the app knows whether to keep its own local ones.
 */
export function POST(req: Request) {
  return handle(async () => {
    const v = await requireUser();
    const body = await readJson(req);
    if (body === null) return jsonError(400, "Send the device as JSON.");
    const parsed = registerSchema.safeParse(body);
    if (!parsed.success) return jsonError(400, firstIssue(parsed.error));
    const device = await registerDevice(v.id, await sessionId(), parsed.data);
    audit(v, "push.device.register", { type: "device", id: device.id }, { platform: parsed.data.platform, appVersion: parsed.data.appVersion ?? null }).catch(() => {});
    return NextResponse.json({ device, ...(await pushStatus(v)) }, { status: 201 });
  });
}

/** DELETE /api/devices { token? }: the app calls this on sign-out. Without a token, removes this session's devices. */
export function DELETE(req: Request) {
  return handle(async () => {
    const v = await requireUser();
    const body = await readJson(req);
    if (body === null) return jsonError(400, "Send the device as JSON.");
    const parsed = unregisterSchema.safeParse(body);
    if (!parsed.success) return jsonError(400, firstIssue(parsed.error));
    const removed = await unregisterDevice(v.id, { token: parsed.data.token, sessionId: await sessionId() });
    if (removed) audit(v, "push.device.remove", undefined, { removed }).catch(() => {});
    return NextResponse.json({ ok: true, removed });
  });
}
