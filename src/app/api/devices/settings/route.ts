import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { parseClock, updatePushPrefs } from "@/lib/push";
import { firstIssue, handle, jsonError, readJson, settingsSchema, settingsView } from "@/lib/push/http";

export const dynamic = "force-dynamic";

/** GET /api/devices/settings: push on or off, which kinds, quiet hours ("22:00"–"07:00", in the account's time zone). */
export function GET() {
  return handle(async () => {
    const v = await requireUser();
    return NextResponse.json(await settingsView(v));
  });
}

/** PATCH /api/devices/settings { enabled?, categories?: { reminders?, waiting?, connections?, clinical? }, quietHours?: { start, end } | null } */
export function PATCH(req: Request) {
  return handle(async () => {
    const v = await requireUser();
    const body = await readJson(req);
    if (body === null) return jsonError(400, "Send the settings as JSON.");
    const parsed = settingsSchema.safeParse(body);
    if (!parsed.success) return jsonError(400, firstIssue(parsed.error));
    const q = parsed.data.quietHours;
    let quiet: { quietStart?: number | null; quietEnd?: number | null } = {};
    if (q === null) quiet = { quietStart: null, quietEnd: null };
    else if (q) {
      const start = parseClock(q.start), end = parseClock(q.end);
      if ((start === null) !== (end === null)) return jsonError(400, "Give quiet hours both a start and an end.");
      quiet = { quietStart: start, quietEnd: end };
    }
    const prefs = await updatePushPrefs(v.id, { enabled: parsed.data.enabled, categories: parsed.data.categories, ...quiet });
    return NextResponse.json(await settingsView(v, prefs));
  });
}
