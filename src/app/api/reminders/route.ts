import { NextResponse } from "next/server";
import { audit, requireUser } from "@/lib/auth";
import { createReminder, listReminders, ReminderInputError } from "@/lib/briefs/reminders";
import { firstIssue, reminderCreateSchema, reminderQuerySchema } from "@/lib/briefs/schemas";
import { handle, jsonError, readJson } from "@/lib/briefs/http";

export const dynamic = "force-dynamic";

/** GET /api/reminders?upcoming&days=14&about=<nodeId>&includeDone&limit=100 */
export function GET(req: Request) {
  return handle(async () => {
    const v = await requireUser();
    const params = Object.fromEntries(new URL(req.url).searchParams);
    const q = reminderQuerySchema.safeParse(params);
    if (!q.success) return jsonError(400, firstIssue(q.error));
    const reminders = await listReminders(v, {
      upcoming: q.data.upcoming, days: q.data.days, aboutNodeId: q.data.about, includeDone: q.data.includeDone, limit: q.data.limit,
    });
    return NextResponse.json({ reminders });
  });
}

/** POST /api/reminders { title, detail?, dueAt, aboutNodeId? } — a reminder the user wrote themselves. */
export function POST(req: Request) {
  return handle(async () => {
    const v = await requireUser();
    const body = await readJson(req);
    if (body === null) return jsonError(400, "Send the reminder as JSON.");
    const parsed = reminderCreateSchema.safeParse(body);
    if (!parsed.success) return jsonError(400, firstIssue(parsed.error));
    try {
      const reminder = await createReminder(v, parsed.data);
      audit(v, "reminder.create", { type: "reminder", id: reminder.id }).catch(() => {});
      return NextResponse.json({ reminder }, { status: 201 });
    } catch (err) {
      if (err instanceof ReminderInputError) return jsonError(400, err.message);
      throw err;
    }
  });
}
