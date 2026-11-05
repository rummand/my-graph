/**
 * Importer `calendar`: events the My Graph for Mac app read from Calendar (EventKit), sent as calendarPayload. Pure.
 *
 * Like the calendar-link connector (connectors/ics), each event becomes a proposed event node, but without flooding:
 *   - only events from 30 days back to 120 days ahead, at most 300 per batch (the nearest first);
 *   - an event already in the graph under its Mac id (props.macEventId) is skipped, or proposed as a change when its
 *     title or time moved; one already there with the same name on the same day (from another calendar, or one My
 *     Graph wrote back to the Mac) is skipped too;
 *   - it is linked to the person whose calendar it is, to attendees already in the graph (by email, else a unique
 *     name), and to a known place named like its location. Unknown attendees are never proposed as people.
 * Every op carries a receipt pointing at the event's line in the import.
 */
import type { ChangeInput } from "@/lib/changes";
import { edgeKey, matchByLabel, matchPerson, normEmail, normName } from "./match";
import { packLines } from "./photos";
import { calendarPayload, type CalendarPayload } from "./schemas";
import type { ImportContext, ImportKnown, ImportPlan, Importer } from "./types";

export const CALENDAR_RULES = { pastDays: 30, futureDays: 120, maxEvents: 300, maxAttendeeLinks: 10 } as const;

type CalEvent = CalendarPayload["events"][number];

const DAY = 86_400_000;
const day = (iso: string) => iso.slice(0, 10);
const clean = (s: string | undefined | null) => (s ?? "").replace(/\s+/g, " ").trim();

const T = {
  en: {
    title: (n: number) => `Calendar from your Mac: ${n} ${n === 1 ? "event" : "events"}`,
    allDay: "all day",
    at: "at",
    with: "with",
    left: (n: number) => `${n} more events in this window were left out to keep this proposal reviewable; they are still in the import's text.`,
  },
  da: {
    title: (n: number) => `Kalender fra din Mac: ${n} ${n === 1 ? "begivenhed" : "begivenheder"}`,
    allDay: "hele dagen",
    at: "i",
    with: "med",
    left: (n: number) => `${n} begivenheder mere i perioden blev udeladt, så forslaget kan gennemgås; de står stadig i importens tekst.`,
  },
};

/** Is the event inside the window (30 days back, 120 ahead)? An event still going on counts. */
export function inCalendarWindow(e: Pick<CalEvent, "start" | "end">, now: Date): boolean {
  const start = Date.parse(e.start);
  const end = e.end ? Date.parse(e.end) : start;
  if (Number.isNaN(start)) return false;
  return Math.max(start, Number.isNaN(end) ? start : end) >= now.getTime() - CALENDAR_RULES.pastDays * DAY
    && start <= now.getTime() + CALENDAR_RULES.futureDays * DAY;
}

/** One line per event: the import's searchable text, and what a receipt quotes. */
export function eventLine(e: CalEvent, locale: "en" | "da"): string {
  const L = T[locale];
  const when = e.allDay ? `${day(e.start)} (${L.allDay})` : `${day(e.start)} ${e.start.slice(11, 16)}${e.end ? `–${day(e.end) === day(e.start) ? e.end.slice(11, 16) : `${day(e.end)} ${e.end.slice(11, 16)}`}` : ""}`;
  const who = (e.attendees ?? []).map((a) => clean(a.name) || clean(a.email)).filter(Boolean).slice(0, 8);
  return [
    `${when}: ${clean(e.title) || "(untitled)"}`,
    e.location ? `${L.at} ${clean(e.location)}` : "",
    who.length ? `${L.with} ${who.join(", ")}` : "",
    `[${clean(e.calendar)}]`,
  ].filter(Boolean).join(" ");
}

function knownByMacId(known: ImportKnown[]): Map<string, ImportKnown> {
  const m = new Map<string, ImportKnown>();
  for (const k of known) if (k.type === "event" && typeof k.props.macEventId === "string") m.set(k.props.macEventId, k);
  return m;
}

/** A known event with this name on this day (another calendar had it, or My Graph wrote it to the Mac). */
function sameNameSameDay(known: ImportKnown[], label: string, start: string): ImportKnown | null {
  const n = normName(label);
  if (!n) return null;
  return known.find((k) => k.type === "event" && !!k.startAt && k.startAt.slice(0, 10) === day(start) && (normName(k.label) === n || k.aliases.some((a) => normName(a) === n))) ?? null;
}

function placeFor(known: ImportKnown[], location: string | undefined): ImportKnown | null {
  const loc = clean(location);
  if (!loc) return null;
  return matchByLabel(known, "place", loc) ?? matchByLabel(known, "place", loc.split(",")[0]);
}

function propsOf(e: CalEvent): Record<string, unknown> {
  return {
    macEventId: e.id,
    calendar: clean(e.calendar).slice(0, 200),
    ...(e.location ? { location: clean(e.location).slice(0, 500) } : {}),
    ...(e.allDay ? { allDay: true, date: day(e.start) } : {}),
    ...(e.url ? { url: e.url } : {}),
  };
}

function summaryOf(e: CalEvent): string | undefined {
  const s = [e.location ? `At ${clean(e.location)}.` : "", clean(e.notes).slice(0, 400)].filter(Boolean).join(" ");
  return s || undefined;
}

export function readCalendar(data: CalendarPayload, ctx: ImportContext): ImportPlan {
  const L = T[ctx.locale];
  const now = ctx.now;
  const seen = new Set<string>();
  const events = data.events
    .filter((e) => clean(e.title) && inCalendarWindow(e, now) && !seen.has(e.id) && seen.add(e.id))
    // The nearest first, so the cap keeps what matters now.
    .sort((a, b) => Math.abs(Date.parse(a.start) - now.getTime()) - Math.abs(Date.parse(b.start) - now.getTime()));

  const byMacId = knownByMacId(ctx.known);
  const changes: ChangeInput[] = [];
  const counts: Record<string, number> = { events: 0, changed: 0, known: 0, people: 0, places: 0 };
  const warnings: string[] = [];
  const edgeOnce = new Set<string>();
  const lineKey = (e: CalEvent) => `${normName(e.calendar).replace(/:/g, " ") || "calendar"}:${e.id}`;
  const lines = [...events].sort((a, b) => a.start.localeCompare(b.start)).map((e) => ({ key: lineKey(e), text: eventLine(e, ctx.locale) }));
  const { segments, where } = packLines(lines);
  const receipt = (e: CalEvent, confidence = 1) => ({
    sourceId: ctx.sourceId, quote: (where.get(lineKey(e))?.quote ?? eventLine(e, ctx.locale)).slice(0, 300),
    locator: { region: where.get(lineKey(e))?.region ?? "calendar", range: `event:${e.id}` }, ...(e.url ? { url: e.url } : {}), confidence,
  });
  const link = (fromId: string, toId: string, relation: string, e: CalEvent, note: string, confidence: number) => {
    const k = edgeKey(fromId, relation, toId);
    if (ctx.existingEdges.has(k) || edgeOnce.has(k)) return false;
    edgeOnce.add(k);
    changes.push({ op: "addEdge", fromId, toId, relation, status: "unconfirmed", confidence, note, receipt: receipt(e, confidence) });
    return true;
  };

  let proposed = 0, left = 0;
  for (const e of events) {
    const label = clean(e.title).slice(0, 200);
    const startAt = new Date(e.start).toISOString();
    const endAt = e.end ? new Date(e.end).toISOString() : null;
    const prev = byMacId.get(e.id);
    if (prev) {
      const moved = normName(prev.label) !== normName(label) || (prev.startAt && Date.parse(prev.startAt) !== Date.parse(startAt));
      if (!moved) { counts.known++; continue; }
      if (proposed >= CALENDAR_RULES.maxEvents) { left++; continue; }
      proposed++;
      counts.changed++;
      changes.push({
        op: "updateNode", nodeId: prev.id, set: { label, startAt, endAt, summary: summaryOf(e) ?? null, props: propsOf(e) },
        note: `The calendar on your Mac changed this (${clean(e.calendar)}).`, receipt: receipt(e),
      });
      continue;
    }
    if (sameNameSameDay(ctx.known, label, e.start)) { counts.known++; continue; }
    if (proposed >= CALENDAR_RULES.maxEvents) { left++; continue; }
    proposed++;
    counts.events++;
    const id = ctx.mint();
    changes.push({
      op: "addNode", nodeId: id, type: "event", label, summary: summaryOf(e), props: propsOf(e), startAt, endAt, visibility: ctx.visibility,
      note: `From the calendar “${clean(e.calendar)}” on your Mac.`, receipt: receipt(e),
    });
    if (ctx.selfNodeId) link(id, ctx.selfNodeId, "involves", e, "It's in their calendar.", 0.9);
    let linked = 0;
    for (const a of e.attendees ?? []) {
      if (linked >= CALENDAR_RULES.maxAttendeeLinks) break;
      const email = a.email && a.email.includes("@") ? normEmail(a.email) : null;
      const hit = matchPerson(ctx.known, { name: clean(a.name) || null, emails: email ? [email] : [] });
      if (!hit || hit.id === ctx.selfNodeId) continue;
      if (link(id, hit.id, "involves", e, `Invited to it (${clean(a.name) || email}).`, email ? 0.9 : 0.7)) { linked++; counts.people++; }
    }
    const place = placeFor(ctx.known, e.location);
    if (place && link(id, place.id, "happened_at", e, `The event's location is “${clean(e.location)}”.`, 0.8)) counts.places++;
  }
  if (left) warnings.push(L.left(left));

  return { segments, changes, counts, warnings, title: L.title(events.length), occurredAt: null, extract: false };
}

export const calendarImporter: Importer = {
  id: "calendar",
  label: "Calendar (Mac)",
  mime: "application/vnd.mygraph.calendar+json",
  // Only arrives as a JSON batch from the Mac app; an uploaded file is never taken for it.
  detect: () => false,
  json: calendarPayload,
  read(input, ctx) {
    let data: CalendarPayload;
    try {
      data = calendarPayload.parse(JSON.parse(input.bytes.toString("utf8")));
    } catch {
      return { segments: [], changes: [], counts: {}, warnings: ["These calendar events aren't in the expected shape."], extract: false };
    }
    return readCalendar(data, ctx);
  },
};
