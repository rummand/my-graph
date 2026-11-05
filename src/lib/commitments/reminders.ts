/**
 * The reminder that goes with a commitment (server-only). One per commitment, linked by reminders.node_id, due lead
 * days before the commitment (or when it is snoozed to). A reminder detection already made from the same source for
 * the same day is adopted instead of making a second one. Closing, reopening and moving follow the commitment.
 *
 * Reminders are the viewer's own rows (the briefs library's rules): only someone who may write in the graph syncs,
 * and only for commitments they may change themselves.
 */
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { reminders } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { scopeOf } from "@/lib/graphs/pure";
import { DEFAULT_TZ, planReminder, type CommitmentView, type ReminderLike } from "./pure";

async function candidates(v: Viewer, list: CommitmentView[]): Promise<ReminderLike[]> {
  const ids = list.map((c) => c.id);
  const srcIds = [...new Set(list.flatMap((c) => c.sources.map((s) => s.sourceId)))];
  const rows = await db.select({ id: reminders.id, nodeId: reminders.nodeId, sourceId: reminders.sourceId, title: reminders.title, dueAt: reminders.dueAt, done: reminders.done })
    .from(reminders).where(and(eq(reminders.graphId, v.graphId), or(
      ids.length ? inArray(reminders.nodeId, ids) : undefined,
      srcIds.length ? and(isNull(reminders.nodeId), inArray(reminders.sourceId, srcIds), eq(reminders.done, false)) : undefined,
    )));
  return rows.map((r) => ({ ...r, dueAt: r.dueAt.toISOString() }));
}

/** Bring the reminders of these commitments in line with them. Returns how many rows changed. Never throws. */
export async function syncReminders(v: Viewer, list: CommitmentView[], now = new Date(), tz = DEFAULT_TZ): Promise<number> {
  const mine = list.filter((c) => c.canEdit);
  if (!mine.length || !scopeOf(v).canWrite || v.role === "guest") return 0;
  let changed = 0;
  try {
    const rows = await candidates(v, mine);
    const taken = new Set<string>();
    for (const c of mine) {
      const pool = rows.filter((r) => !taken.has(r.id) || r.nodeId === c.id);
      const plan = planReminder({ ...c, sourceIds: c.sources.map((s) => s.sourceId) }, pool, now, tz);
      if ("id" in plan) taken.add(plan.id);
      // A renamed commitment renames its own reminder (not one detection made and we only adopted the date of).
      const own = rows.find((r) => r.nodeId === c.id && !r.done);
      if (own && own.title !== c.label.slice(0, 200) && (plan.action === "none" || plan.action === "move")) {
        await db.update(reminders).set({ title: c.label.slice(0, 200) }).where(and(eq(reminders.id, own.id), eq(reminders.graphId, v.graphId)));
        changed++;
      }
      switch (plan.action) {
        case "none": break;
        case "create": {
          const about = c.responsible.find((p) => p.type === "person")?.id ?? c.about[0]?.id ?? null;
          await db.insert(reminders).values({
            householdId: v.graphHouseholdId, graphId: v.graphId, ownerId: v.id, nodeId: c.id, aboutNodeId: about,
            sourceId: c.sources[0]?.sourceId ?? null, title: c.label.slice(0, 200), detail: c.props.consequence ?? null,
            dueAt: new Date(plan.dueAt), createdByKind: "user",
          });
          changed++;
          break;
        }
        case "adopt":
          await db.update(reminders).set({ nodeId: c.id, dueAt: new Date(plan.dueAt) }).where(and(eq(reminders.id, plan.id), eq(reminders.graphId, v.graphId)));
          changed++;
          break;
        case "move":
          await db.update(reminders).set({ dueAt: new Date(plan.dueAt) }).where(and(eq(reminders.id, plan.id), eq(reminders.graphId, v.graphId)));
          changed++;
          break;
        case "reopen":
          await db.update(reminders).set({ done: false, dueAt: new Date(plan.dueAt) }).where(and(eq(reminders.id, plan.id), eq(reminders.graphId, v.graphId)));
          changed++;
          break;
        case "close":
          await db.update(reminders).set({ done: true }).where(and(eq(reminders.graphId, v.graphId), eq(reminders.nodeId, c.id), eq(reminders.done, false)));
          changed++;
          break;
      }
    }
  } catch (e) {
    console.error("[commitments] reminders could not be synced", e);
  }
  return changed;
}
