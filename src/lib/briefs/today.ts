/**
 * Everything the Today page and the daily brief need, loaded in parallel. Each section loads independently so one
 * failing service (GBrain, mux) never blanks the page: a section is either { ok: true, data } or { ok: false, error }.
 * Server-only.
 */
import type { Viewer } from "@/lib/auth";
import * as gbrain from "@/lib/gbrain";
import type { BriefInput } from "./context";
import { addDaysInZone, ageThisYear, appTimeZone, startOfDayInZone } from "./dates";
import { loadAttentionFacts, loadChildren, loadFailedUploads, loadRecentSources, loadRecentWikiPages, type AttentionFact, type SourceRow, type WikiRow } from "./queries";
import { listReminders, type ReminderDTO } from "./reminders";

export type Section<T> = { ok: true; data: T } | { ok: false; error: string };

async function section<T>(name: string, fn: () => Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    console.error(`[today] ${name} failed:`, err);
    // Details stay in the server log; database errors can quote queries and values.
    return { ok: false, error: "This part couldn't be loaded right now." };
  }
}

/** An event as sent to the browser. */
export type EventItem = {
  id: string; label: string; summary: string | null; startAt: string; endAt: string | null;
  timePrecision: "minute" | "day" | "month" | "year" | null; sensitive: boolean;
  children: { userId: string; name: string }[];
};

export type ChildCard = {
  userId: string; name: string; age: number | null; personNodeId: string | null;
  nextEvent: EventItem | null; openReminders: ReminderDTO[];
};

export type TodayCore = {
  now: Date; tz: string;
  events: Section<EventItem[]>;
  reminders: Section<ReminderDTO[]>;
  children: Section<ChildCard[]>;
  attention: Section<{ facts: AttentionFact[]; total: number }>;
  failedUploads: Section<{ items: SourceRow[]; total: number }>;
};

export type TodayData = TodayCore & {
  mergeSuggestions: number | null;
  recentSources: Section<SourceRow[]>;
  recentWiki: Section<WikiRow[]>;
};

/** How many days "Coming up" covers (today included). */
export const COMING_UP_DAYS = 14;

export async function loadTodayCore(v: Viewer, now = new Date()): Promise<TodayCore> {
  const tz = appTimeZone();
  const from = startOfDayInZone(now, tz);
  const to = addDaysInZone(from, COMING_UP_DAYS + 1, tz);

  const [childrenRows, timeline, reminders, attention, failedUploads] = await Promise.all([
    section("children", () => loadChildren(v)),
    section("timeline", () => gbrain.timeline(v, { from, to, limit: 200 })),
    section("reminders", () => listReminders(v, { includeDone: false, limit: 100, now })),
    section("attention", () => loadAttentionFacts(v, { now })),
    section("failed uploads", () => loadFailedUploads(v)),
  ]);

  const kids = childrenRows.ok ? childrenRows.data : [];
  const childByPerson = new Map(kids.filter((c) => c.personNodeId).map((c) => [c.personNodeId!, c]));

  const events: Section<EventItem[]> = timeline.ok
    ? {
        ok: true,
        data: timeline.data.events
          .filter((e) => e.startAt)
          .map((e): EventItem => {
            const childIds = new Set(timeline.data.involves.filter((i) => i.eventId === e.id).map((i) => i.personId));
            return {
              id: e.id, label: e.label, summary: e.summary, startAt: e.startAt!.toISOString(), endAt: e.endAt?.toISOString() ?? null,
              timePrecision: e.timePrecision, sensitive: e.sensitive,
              children: [...childIds].flatMap((pid) => {
                const c = childByPerson.get(pid);
                return c ? [{ userId: c.id, name: c.name }] : [];
              }),
            };
          })
          .sort((a, b) => a.startAt.localeCompare(b.startAt)),
      }
    : timeline;

  const children: Section<ChildCard[]> = childrenRows.ok
    ? {
        ok: true,
        data: kids.map((c): ChildCard => ({
          userId: c.id,
          name: c.name,
          age: ageThisYear(c.birthYear, now, tz),
          personNodeId: c.personNodeId,
          nextEvent: events.ok ? events.data.find((e) => e.children.some((k) => k.userId === c.id) && new Date(e.endAt ?? e.startAt) >= now) ?? null : null,
          openReminders: reminders.ok && c.personNodeId ? reminders.data.filter((r) => !r.done && r.aboutNodeId === c.personNodeId) : [],
        })),
      }
    : childrenRows;

  return { now, tz, events, reminders, children, attention, failedUploads };
}

export async function loadToday(v: Viewer, now = new Date()): Promise<TodayData> {
  const [core, merges, recentSources, recentWiki] = await Promise.all([
    loadTodayCore(v, now),
    gbrain.mergeSuggestions(v, 20).then((s) => s.length, (err) => {
      console.error("[today] merge suggestions failed:", err);
      return null;
    }),
    section("recent sources", () => loadRecentSources(v)),
    section("recent wiki", () => loadRecentWikiPages(v)),
  ]);
  return { ...core, mergeSuggestions: merges, recentSources, recentWiki };
}

/** The brief's input from the loaded sections (sections that failed simply contribute nothing). */
export function toBriefInput(v: Pick<Viewer, "name">, core: TodayCore): BriefInput {
  const childNames = new Map((core.children.ok ? core.children.data : []).map((c) => [c.personNodeId, c.name]));
  return {
    now: core.now,
    tz: core.tz,
    viewerName: v.name,
    children: core.children.ok ? core.children.data.map((c) => ({ name: c.name, age: c.age })) : [],
    events: core.events.ok
      ? core.events.data.map((e) => ({
          id: e.id, label: e.label, summary: e.summary, startAt: new Date(e.startAt), endAt: e.endAt ? new Date(e.endAt) : null,
          timePrecision: e.timePrecision, sensitive: e.sensitive, people: e.children.map((c) => c.name),
        }))
      : [],
    reminders: core.reminders.ok
      ? core.reminders.data.filter((r) => !r.done).map((r) => ({
          id: r.id, title: r.title, detail: r.detail, dueAt: new Date(r.dueAt),
          about: (r.aboutNodeId && childNames.get(r.aboutNodeId)) || r.aboutLabel,
          nodeId: r.nodeId, sourceId: r.sourceId,
        }))
      : [],
    facts: core.attention.ok
      ? core.attention.data.facts.map((f) => ({
          edgeId: f.edgeId, fromId: f.fromId, text: f.text, confidence: f.confidence, sourceId: f.sourceId,
          sourceTitle: f.sourceTitle, quote: f.quote, sensitive: f.sensitive,
        }))
      : [],
    failedUploads: core.failedUploads.ok ? core.failedUploads.data.items.map((s) => ({ id: s.id, title: s.title })) : [],
  };
}
