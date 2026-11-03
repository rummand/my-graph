/** Append-only audit log writer. No Next imports, so scripts can use it too. */
import { db } from "@/db";
import { auditLog } from "@/db/schema";

export async function writeAudit(
  v: { id: string | null; householdId: string } | null,
  action: string,
  target?: { type: string; id: string },
  meta: Record<string, unknown> = {},
): Promise<void> {
  if (!v) {
    // No household to file it under (e.g. a failed sign-in for an unknown email): keep it in the server log.
    console.warn("[audit]", action, target ? `${target.type}:${target.id}` : "", JSON.stringify(meta));
    return;
  }
  try {
    await db.insert(auditLog).values({
      householdId: v.householdId, userId: v.id, action,
      targetType: target?.type ?? null, targetId: target?.id ?? null, meta,
    });
  } catch (err) {
    // Never lose the event silently, but don't fail the user's action because the log write failed.
    console.error("[audit] write failed", action, err instanceof Error ? err.message : err);
  }
}
