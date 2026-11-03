import { NextResponse } from "next/server";
import { audit, requireUser } from "@/lib/auth";
import { deleteReminder, getReminder, updateReminder } from "@/lib/briefs/reminders";
import { firstIssue, reminderIdSchema, reminderPatchSchema } from "@/lib/briefs/schemas";
import { handle, jsonError, readJson } from "@/lib/briefs/http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const NOT_FOUND = "That reminder doesn't exist or you can't change it.";

export function GET(_req: Request, { params }: Ctx) {
  return handle(async () => {
    const v = await requireUser();
    const id = reminderIdSchema.safeParse((await params).id);
    if (!id.success) return jsonError(404, NOT_FOUND);
    const reminder = await getReminder(v, id.data);
    return reminder ? NextResponse.json({ reminder }) : jsonError(404, NOT_FOUND);
  });
}

/** PATCH /api/reminders/:id { done?, dueAt?, title?, detail? } */
export function PATCH(req: Request, { params }: Ctx) {
  return handle(async () => {
    const v = await requireUser();
    const id = reminderIdSchema.safeParse((await params).id);
    if (!id.success) return jsonError(404, NOT_FOUND);
    const body = await readJson(req);
    if (body === null) return jsonError(400, "Send the changes as JSON.");
    const patch = reminderPatchSchema.safeParse(body);
    if (!patch.success) return jsonError(400, firstIssue(patch.error));
    const reminder = await updateReminder(v, id.data, patch.data);
    if (!reminder) return jsonError(404, NOT_FOUND);
    audit(v, "reminder.update", { type: "reminder", id: reminder.id }, { fields: Object.keys(body as object) }).catch(() => {});
    return NextResponse.json({ reminder });
  });
}

export function DELETE(_req: Request, { params }: Ctx) {
  return handle(async () => {
    const v = await requireUser();
    const id = reminderIdSchema.safeParse((await params).id);
    if (!id.success) return jsonError(404, NOT_FOUND);
    if (!(await deleteReminder(v, id.data))) return jsonError(404, NOT_FOUND);
    audit(v, "reminder.delete", { type: "reminder", id: id.data }).catch(() => {});
    return NextResponse.json({ ok: true });
  });
}
