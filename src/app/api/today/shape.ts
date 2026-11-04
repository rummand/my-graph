/**
 * Pure helpers for GET /api/today (no database): grouping the week by person, the attention summary, and the
 * greeting's first name. Kept apart from the route so vitest can check them.
 */

export type WeekItemInput = {
  id: string; kind: string; title: string; start: string; precision: string | null;
  personIds: string[]; nodeId: string | null; sourceId: string | null;
};
export type WeekReminderInput = {
  id: string; title: string; dueAt: string | Date; done: boolean; aboutNodeId: string | null; nodeId: string | null; sourceId: string | null;
};
export type WeekPerson = { id: string; label: string };

export type WeekEntry = {
  id: string; title: string; at: string; allDay: boolean; isReminder: boolean;
  /** What a tap opens: a graph node, else a library document. */
  nodeId: string | null; sourceId: string | null;
  /** The reminder's id (to tick it), for reminders only. */
  reminderId: string | null;
};
export type WeekGroup = { id: string; personId: string | null; name: string; entries: WeekEntry[] };

const iso = (d: string | Date) => (typeof d === "string" ? new Date(d) : d).toISOString();

/**
 * One row per person for the next days: their events and open reminders, in time order. Events with nobody (or only
 * people outside `people`) and reminders about nobody go on the shared row, named `everyoneLabel`, which comes last.
 * People keep the order of `people`; an event with two people shows on both rows.
 */
export function groupWeek(input: {
  items: WeekItemInput[]; reminders: WeekReminderInput[]; people: WeekPerson[];
  end: Date; everyoneLabel: string;
}): WeekGroup[] {
  const names = new Map(input.people.map((p) => [p.id, p.label]));
  const order = new Map(input.people.map((p, i) => [p.id, i]));
  const groups = new Map<string, WeekGroup>();
  const add = (pid: string | null, e: WeekEntry) => {
    const key = pid ?? "everyone";
    let g = groups.get(key);
    if (!g) { g = { id: key, personId: pid, name: pid ? names.get(pid) ?? input.everyoneLabel : input.everyoneLabel, entries: [] }; groups.set(key, g); }
    if (!g.entries.some((x) => x.id === e.id)) g.entries.push(e);
  };
  for (const it of input.items) {
    if (it.kind !== "event") continue;
    const e: WeekEntry = {
      id: it.id, title: it.title, at: iso(it.start), allDay: it.precision !== "minute", isReminder: false,
      nodeId: it.nodeId, sourceId: it.sourceId, reminderId: null,
    };
    const pids = it.personIds.filter((p) => names.has(p));
    if (pids.length === 0) add(null, e); else for (const p of pids) add(p, e);
  }
  for (const r of input.reminders) {
    const due = typeof r.dueAt === "string" ? new Date(r.dueAt) : r.dueAt;
    if (r.done || !(due < input.end)) continue;
    const e: WeekEntry = {
      id: `r:${r.id}`, title: r.title, at: due.toISOString(), allDay: false, isReminder: true,
      nodeId: r.nodeId, sourceId: r.sourceId, reminderId: r.id,
    };
    add(r.aboutNodeId && names.has(r.aboutNodeId) ? r.aboutNodeId : null, e);
  }
  const out = [...groups.values()];
  for (const g of out) g.entries.sort((a, b) => a.at.localeCompare(b.at));
  out.sort((a, b) => {
    const ia = a.personId ? order.get(a.personId) ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
    const ib = b.personId ? order.get(b.personId) ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
    return ia === ib ? a.name.localeCompare(b.name) : ia - ib;
  });
  return out;
}

/** "Anna Hansen" → "Anna"; an empty name stays as it is. */
export function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

/** The count badge on "Needs attention": unsure facts, failed uploads and possible duplicates (missing parts count 0). */
export function attentionTotal(parts: { facts: number | null; failedUploads: number | null; duplicates: number | null }): number {
  return (parts.facts ?? 0) + (parts.failedUploads ?? 0) + (parts.duplicates ?? 0);
}
