/**
 * Reminders: read and write with access checks. Server-only.
 * Access: the reminder's owner, or any parent/owner in the household (see canManageReminder).
 */
import { and, asc, eq, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { nodes, reminders, sources } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { canManageReminder, isParentRole } from "./access";
import type { ReminderCreate, ReminderPatch } from "./schemas";
import { inGraph, visibleWhere } from "./sql";
import { scopeOf } from "@/lib/graphs/pure";

/** A reminder as sent to the browser (dates as ISO strings). */
export type ReminderDTO = {
  id: string;
  ownerId: string;
  title: string;
  detail: string | null;
  dueAt: string;
  done: boolean;
  aboutNodeId: string | null;
  aboutLabel: string | null;
  nodeId: string | null;
  sourceId: string | null;
  createdByKind: "user" | "assistant";
  createdAt: string;
};

/** Only reveal the label of the node a reminder is about when the viewer may see that node. */
const aboutLabelFor = (v: Viewer) => sql<string | null>`(select ${nodes.label} from ${nodes} where ${and(eq(nodes.id, reminders.aboutNodeId), visibleWhere(v, nodes))})`;

const selectCols = (v: Viewer) => ({
  id: reminders.id,
  householdId: reminders.householdId,
  graphId: reminders.graphId,
  ownerId: reminders.ownerId,
  title: reminders.title,
  detail: reminders.detail,
  dueAt: reminders.dueAt,
  done: reminders.done,
  aboutNodeId: reminders.aboutNodeId,
  aboutLabel: aboutLabelFor(v),
  nodeId: reminders.nodeId,
  sourceId: reminders.sourceId,
  createdByKind: reminders.createdByKind,
  createdAt: reminders.createdAt,
});

const baseSelect = (v: Viewer) => db.select(selectCols(v)).from(reminders);
type Row = Awaited<ReturnType<typeof baseSelect>>[number];

function toDTO(r: Row): ReminderDTO {
  return {
    id: r.id, ownerId: r.ownerId, title: r.title, detail: r.detail, dueAt: r.dueAt.toISOString(), done: r.done,
    aboutNodeId: r.aboutNodeId, aboutLabel: r.aboutLabel ?? null, nodeId: r.nodeId, sourceId: r.sourceId,
    createdByKind: r.createdByKind, createdAt: r.createdAt.toISOString(),
  };
}

/**
 * Own reminders; parents also see other household members' reminders, except ones that came from a file the parent
 * can't open (an assistant reminder read from someone's private letter must not reveal what the letter says).
 */
function accessWhere(v: Viewer): SQL {
  const own = and(inGraph(v, reminders.graphId), eq(reminders.ownerId, v.id))!;
  if (!isParentRole(scopeOf(v).role)) return own;
  const sourceOk = sql`(${reminders.sourceId} is null or exists (select 1 from ${sources} where ${and(eq(sources.id, reminders.sourceId), visibleWhere(v, sources))}))`;
  return or(own, and(inGraph(v, reminders.graphId), sourceOk))!;
}

export async function listReminders(v: Viewer, opts: { upcoming?: boolean; days?: number; aboutNodeId?: string; includeDone?: boolean; limit?: number; now?: Date } = {}): Promise<ReminderDTO[]> {
  const now = opts.now ?? new Date();
  const conds: SQL[] = [accessWhere(v)];
  if (opts.upcoming) {
    conds.push(eq(reminders.done, false));
    conds.push(lte(reminders.dueAt, new Date(now.getTime() + (opts.days ?? 14) * 86_400_000)));
  } else if (!opts.includeDone) {
    conds.push(eq(reminders.done, false));
  }
  if (opts.aboutNodeId) conds.push(eq(reminders.aboutNodeId, opts.aboutNodeId));
  const rows = await baseSelect(v)
    .where(and(...conds))
    .orderBy(asc(reminders.done), asc(reminders.dueAt))
    .limit(Math.min(opts.limit ?? 100, 200));
  return rows.map(toDTO);
}

/** The reminder row if the viewer may see and manage it. */
async function getRow(v: Viewer, id: string): Promise<Row | null> {
  const [row] = await baseSelect(v).where(and(eq(reminders.id, id), accessWhere(v))).limit(1);
  return row ?? null;
}

/** The reminder if the viewer may manage it, else null (callers answer 404 either way, so ids don't leak). */
export async function getReminder(v: Viewer, id: string): Promise<ReminderDTO | null> {
  const row = await getRow(v, id);
  return row && canManageReminder(v, row) ? toDTO(row) : null;
}

/** Whether `nodeId` is a live node in the viewer's household that the viewer may see. */
export async function nodeVisibleTo(v: Viewer, nodeId: string): Promise<boolean> {
  const [n] = await db.select({ id: nodes.id }).from(nodes)
    .where(and(eq(nodes.id, nodeId), isNull(nodes.mergedInto), visibleWhere(v, nodes)))
    .limit(1);
  if (n) return true;
  // Family members' own person nodes are always fine to set a reminder about.
  const [p] = await db.select({ id: nodes.id }).from(nodes)
    .where(and(eq(nodes.id, nodeId), eq(nodes.graphId, v.graphId), eq(nodes.type, "person"), isNull(nodes.mergedInto)))
    .limit(1);
  return Boolean(p);
}

export class ReminderInputError extends Error {}

export async function createReminder(v: Viewer, input: ReminderCreate): Promise<ReminderDTO> {
  if (!scopeOf(v).canWrite) throw new ReminderInputError("You can look at this graph but not add reminders to it.");
  if (input.aboutNodeId && !(await nodeVisibleTo(v, input.aboutNodeId))) {
    throw new ReminderInputError("We couldn't find the person or item this reminder is about.");
  }
  const [row] = await db.insert(reminders).values({
    householdId: v.graphHouseholdId,
    graphId: v.graphId,
    ownerId: v.id,
    title: input.title,
    detail: input.detail,
    dueAt: input.dueAt,
    aboutNodeId: input.aboutNodeId,
    createdByKind: "user",
  }).returning({ id: reminders.id });
  return (await getReminder(v, row.id))!;
}

/** Null when not found or not allowed. */
export async function updateReminder(v: Viewer, id: string, patch: ReminderPatch): Promise<ReminderDTO | null> {
  const existing = await getRow(v, id);
  if (!existing || !canManageReminder(v, existing)) return null;
  const set: Partial<typeof reminders.$inferInsert> = {};
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.detail !== undefined) set.detail = patch.detail;
  if (patch.dueAt !== undefined) set.dueAt = patch.dueAt;
  if (patch.done !== undefined) set.done = patch.done;
  await db.update(reminders).set(set).where(eq(reminders.id, id));
  return getReminder(v, id);
}

/** False when not found or not allowed. */
export async function deleteReminder(v: Viewer, id: string): Promise<boolean> {
  const existing = await getRow(v, id);
  if (!existing || !canManageReminder(v, existing)) return false;
  await db.delete(reminders).where(eq(reminders.id, id));
  return true;
}

/** Open reminders about any of these nodes (for child cards). */
export function remindersAbout(list: ReminderDTO[], nodeIds: (string | null)[]): Map<string, ReminderDTO[]> {
  const ids = new Set(nodeIds.filter((x): x is string => Boolean(x)));
  const map = new Map<string, ReminderDTO[]>();
  for (const r of list) {
    if (r.done || !r.aboutNodeId || !ids.has(r.aboutNodeId)) continue;
    const l = map.get(r.aboutNodeId) ?? [];
    l.push(r);
    map.set(r.aboutNodeId, l);
  }
  return map;
}
