/**
 * Calendar feeds (.ics) to plain events. Pure (no DB, no network): parsing with ical.js, recurring events expanded
 * inside a window, exceptions (RECURRENCE-ID) applied, times turned into UTC whether the feed uses UTC, a named
 * IANA zone, a zone defined in the file (VTIMEZONE) or floating times (read in the calendar's or the default zone).
 * Every event gets a stable key (UID, plus the occurrence start for repeats) and a fingerprint of what a person
 * would notice, so a re-read can tell new, changed and unchanged apart.
 */
import { createHash } from "node:crypto";
import ICAL from "ical.js";

export type IcsEvent = {
  /** Dedupe key: the UID, or UID#<occurrence start> for one occurrence of a repeating event. */
  key: string;
  uid: string;
  summary: string;
  description: string | null;
  location: string | null;
  url: string | null;
  start: Date;
  end: Date | null;
  allDay: boolean;
  /** For all-day events: the calendar date "2026-11-26" (no time zone games when showing it). */
  date: string | null;
  status: "confirmed" | "tentative" | "cancelled";
  sequence: number;
  lastModified: string | null;
  organizer: string | null;
  categories: string[];
  recurring: boolean;
  fingerprint: string;
};

export type ParsedCalendar = { name: string | null; timeZone: string | null; events: IcsEvent[]; skipped: number; truncated: boolean };

export type ParseOptions = { now?: Date; pastDays?: number; futureDays?: number; defaultZone?: string; maxEvents?: number; maxPerSeries?: number };

type Wall = { year: number; month: number; day: number; hour: number; minute: number; second: number; isDate: boolean };

export function isIanaZone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Offset (ms) of an IANA zone from UTC at a UTC instant. */
function offsetAt(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - (utcMs - (utcMs % 1000));
}

/** Wall-clock time in a zone → the UTC instant (two passes settle DST edges). */
export function zonedToUtc(w: Omit<Wall, "isDate">, tz: string): Date {
  const naive = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  let guess = naive - offsetAt(naive, tz);
  guess = naive - offsetAt(guess, tz);
  return new Date(guess);
}

const pad = (n: number) => String(n).padStart(2, "0");
const wallOf = (t: ICAL.Time): Wall => ({ year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute, second: t.second, isDate: t.isDate });

function clean(s: unknown, max: number): string | null {
  if (typeof s !== "string") return null;
  const t = s.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
  return t ? t.slice(0, max) : null;
}

export function fingerprintOf(e: Omit<IcsEvent, "fingerprint" | "key" | "sequence" | "lastModified" | "recurring">): string {
  const basis = [e.summary, e.description ?? "", e.location ?? "", e.url ?? "", e.start.toISOString(), e.end?.toISOString() ?? "", e.allDay ? "1" : "0", e.status, e.categories.join(",")].join("\u001f");
  return createHash("sha256").update(basis).digest("hex").slice(0, 32);
}

/**
 * Parse an .ics text. Throws only when the text isn't a calendar at all; single broken events are skipped and counted.
 * Defaults: one year back, 400 days ahead, at most 2000 events, 200 occurrences per repeating event.
 */
export function parseIcs(text: string, opts: ParseOptions = {}): ParsedCalendar {
  const now = opts.now ?? new Date();
  const from = now.getTime() - (opts.pastDays ?? 365) * 86_400_000;
  const to = now.getTime() + (opts.futureDays ?? 400) * 86_400_000;
  const maxEvents = opts.maxEvents ?? 2000;
  const maxPerSeries = opts.maxPerSeries ?? 200;

  if (!/BEGIN:VCALENDAR/i.test(text.slice(0, 4096))) throw new Error("This link doesn't return a calendar (no BEGIN:VCALENDAR).");
  const root = new ICAL.Component(ICAL.parse(text) as unknown as unknown[]);
  const cal = root.name === "vcalendar" ? root : root.getFirstSubcomponent("vcalendar") ?? root;
  const name = clean(cal.getFirstPropertyValue("x-wr-calname"), 200);
  const calZone = clean(cal.getFirstPropertyValue("x-wr-timezone"), 80);
  const defaultZone = isIanaZone(calZone) ? calZone : isIanaZone(opts.defaultZone) ? opts.defaultZone! : "Europe/Copenhagen";

  const zones = new Map<string, ICAL.Timezone>();
  for (const vtz of cal.getAllSubcomponents("vtimezone")) {
    const id = vtz.getFirstPropertyValue("tzid");
    if (typeof id === "string") {
      try { zones.set(id, new ICAL.Timezone(vtz)); } catch { /* broken zone: Intl or the default is used */ }
    }
  }

  const toUtc = (t: ICAL.Time, tzid: string | null): Date => {
    const w = wallOf(t);
    if (w.isDate) return new Date(Date.UTC(w.year, w.month - 1, w.day));
    if (t.zone && (t.zone === ICAL.Timezone.utcTimezone || t.zone.tzid === "UTC" || t.zone.tzid === "Z")) {
      return new Date(Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second));
    }
    if (tzid && isIanaZone(tzid)) return zonedToUtc(w, tzid);
    if (tzid && zones.has(tzid)) return new Date(new ICAL.Time({ ...w, isDate: false }, zones.get(tzid)!).toUnixTime() * 1000);
    return zonedToUtc(w, defaultZone);
  };

  const vevents = cal.getAllSubcomponents("vevent");
  let skipped = 0;
  // Exceptions (RECURRENCE-ID) belong to their series; attach them to the master instead of listing them twice.
  const masters = new Map<string, ICAL.Event>();
  const exceptions: ICAL.Component[] = [];
  for (const c of vevents) {
    if (c.hasProperty("recurrence-id")) exceptions.push(c);
    else {
      const uid = c.getFirstPropertyValue("uid");
      if (typeof uid !== "string" || !uid.trim()) skipped++;
      else if (!masters.has(uid)) masters.set(uid, new ICAL.Event(c));
    }
  }
  const orphanExceptions: ICAL.Component[] = [];
  for (const c of exceptions) {
    const m = masters.get(String(c.getFirstPropertyValue("uid")));
    if (m && m.isRecurring()) {
      try { m.relateException(c); } catch { orphanExceptions.push(c); }
    } else orphanExceptions.push(c);
  }

  const out: IcsEvent[] = [];
  let truncated = false;
  const seen = new Set<string>();

  const push = (e: Omit<IcsEvent, "fingerprint">) => {
    if (seen.has(e.key)) return;
    if (out.length >= maxEvents) { truncated = true; return; }
    seen.add(e.key);
    out.push({ ...e, fingerprint: fingerprintOf(e) });
  };

  const base = (comp: ICAL.Component, uid: string) => {
    const status = String(comp.getFirstPropertyValue("status") ?? "").toLowerCase();
    const org = comp.getFirstProperty("organizer");
    const orgName = org ? (org.getParameter("cn") as string | undefined) ?? String(org.getFirstValue() ?? "").replace(/^mailto:/i, "") : null;
    const cats = comp.getAllProperties("categories").flatMap((p) => p.getValues().map(String)).map((s) => s.trim()).filter(Boolean).slice(0, 10);
    const lm = comp.getFirstPropertyValue("last-modified") as ICAL.Time | null;
    return {
      uid,
      summary: clean(comp.getFirstPropertyValue("summary"), 300) ?? "(no title)",
      description: clean(comp.getFirstPropertyValue("description"), 8000),
      location: clean(comp.getFirstPropertyValue("location"), 500),
      url: clean(comp.getFirstPropertyValue("url"), 1000),
      status: (status === "cancelled" ? "cancelled" : status === "tentative" ? "tentative" : "confirmed") as IcsEvent["status"],
      sequence: Number(comp.getFirstPropertyValue("sequence")) || 0,
      lastModified: lm && typeof lm.toJSDate === "function" ? lm.toJSDate().toISOString() : null,
      organizer: clean(orgName, 200),
      categories: cats,
    };
  };

  const tzidOf = (comp: ICAL.Component, prop: string): string | null => {
    const p = comp.getFirstProperty(prop);
    const v = p?.getParameter("tzid");
    return typeof v === "string" ? v : null;
  };

  const dateStr = (w: Wall) => `${w.year}-${pad(w.month)}-${pad(w.day)}`;

  const single = (comp: ICAL.Component, keySuffix: string | null) => {
    const uid = String(comp.getFirstPropertyValue("uid") ?? "").trim();
    const dtstart = comp.getFirstPropertyValue("dtstart") as ICAL.Time | null;
    if (!uid || !dtstart || typeof dtstart.year !== "number") { skipped++; return; }
    const ev = new ICAL.Event(comp);
    const startTz = tzidOf(comp, "dtstart");
    const start = toUtc(dtstart, startTz);
    const endT = ev.endDate;
    let end = endT ? toUtc(endT, tzidOf(comp, "dtend") ?? startTz) : null;
    if (end && end.getTime() <= start.getTime()) end = null;
    if (start.getTime() < from || start.getTime() > to) return;
    const w = wallOf(dtstart);
    push({ key: keySuffix ? `${uid}#${keySuffix}` : uid, ...base(comp, uid), start, end, allDay: w.isDate, date: w.isDate ? dateStr(w) : null, recurring: !!keySuffix });
  };

  for (const [uid, ev] of masters) {
    try {
      if (!ev.isRecurring()) { single(ev.component, null); continue; }
      const startTz = tzidOf(ev.component, "dtstart");
      const it = ev.iterator();
      let n = 0;
      for (let next = it.next(); next; next = it.next()) {
        const occStart = toUtc(next, startTz);
        if (occStart.getTime() > to) break;
        if (++n > 5000) break; // a rule that never reaches the window
        if (occStart.getTime() < from) continue;
        const d = ev.getOccurrenceDetails(next);
        const comp = d.item.component;
        const w = wallOf(next);
        const suffix = w.isDate ? dateStr(w) : occStart.toISOString();
        const s = toUtc(d.startDate, tzidOf(comp, "dtstart") ?? startTz);
        let e = d.endDate ? toUtc(d.endDate, tzidOf(comp, "dtend") ?? tzidOf(comp, "dtstart") ?? startTz) : null;
        if (e && e.getTime() <= s.getTime()) e = null;
        const sw = wallOf(d.startDate);
        push({ key: `${uid}#${suffix}`, ...base(comp, uid), start: s, end: e, allDay: sw.isDate, date: sw.isDate ? dateStr(sw) : null, recurring: true });
        if (out.filter((x) => x.uid === uid).length >= maxPerSeries) break;
      }
    } catch {
      skipped++;
    }
  }
  for (const c of orphanExceptions) {
    try {
      const rid = c.getFirstPropertyValue("recurrence-id") as ICAL.Time;
      const w = wallOf(rid);
      single(c, w.isDate ? dateStr(w) : toUtc(rid, tzidOf(c, "recurrence-id")).toISOString());
    } catch {
      skipped++;
    }
  }
  out.sort((a, b) => a.start.getTime() - b.start.getTime());
  return { name, timeZone: calZone, events: out, skipped, truncated };
}

/** The text kept as the event's source: what a person would read in the calendar. */
export function eventText(e: IcsEvent, calendarName: string | null): string {
  const lines = [e.summary];
  lines.push(e.allDay ? `Date: ${e.date}` : `Starts: ${e.start.toISOString()}${e.end ? `\nEnds: ${e.end.toISOString()}` : ""}`);
  if (e.location) lines.push(`Where: ${e.location}`);
  if (e.organizer) lines.push(`Organiser: ${e.organizer}`);
  if (e.status !== "confirmed") lines.push(`Status: ${e.status}`);
  if (calendarName) lines.push(`Calendar: ${calendarName}`);
  if (e.description) lines.push("", e.description);
  return lines.join("\n");
}

export type DedupeVerdict = { key: string; action: "add" | "update" | "unchanged" | "cancel" };

/** New, changed, unchanged or cancelled, against what is already stored (key → fingerprint). Pure. */
export function diffEvents(events: IcsEvent[], known: Map<string, { fingerprint: string | null; cancelled?: boolean }>): DedupeVerdict[] {
  return events.map((e) => {
    const k = known.get(e.key);
    if (!k) return { key: e.key, action: e.status === "cancelled" ? "unchanged" : "add" };
    if (e.status === "cancelled") return { key: e.key, action: k.cancelled ? "unchanged" : "cancel" };
    return { key: e.key, action: k.fingerprint === e.fingerprint ? "unchanged" : "update" };
  });
}
