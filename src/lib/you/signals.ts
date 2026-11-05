/**
 * Rows → weekly signals (pure). The server reads only rows that are the person's own or about them (./gather) and
 * hands them here; this file decides what each row counts as. Health events are never counted (they stay where they
 * are, sensitive and private); a person's own check-ins are their mood readings; the tone of their own notes counts
 * only when they turned that on.
 */
import { localClock, spanDays, weekly, weekOf } from "./series";
import type { PersonSeries, SignalSet } from "./patterns";
import type { Point, Ref, Series, SignalKey } from "./types";

export type EventRow = {
  id: string; kind: string | null; label: string; startAt: Date; endAt: Date | null; props: Record<string, unknown>; href: string | null;
};
export type ContactRow = { personId: string; name: string; at: Date; href: string | null; title: string };
export type CommitmentRow = { id: string; label: string; createdAt: Date; props: Record<string, unknown>; href: string | null };
export type MoodRow = { at: Date; value: number; href: string | null; title: string };
export type DocRow = { at: Date; href: string | null; title: string; work: boolean };

export type EventClass = { meeting: boolean; evening: boolean; outdoorsDays: boolean; away: boolean; hours: number };

/** What a calendar/graph event counts as. */
export function classifyEvent(e: Pick<EventRow, "kind" | "startAt" | "endAt" | "props">, tz: string): EventClass | null {
  const p = e.props ?? {};
  if (p.health) return null; // health stays out of You entirely
  const trip = e.kind === "trip";
  const fromPhotos = p.from === "photos";
  const activity = e.kind === "activity";
  if (trip) return { meeting: false, evening: false, outdoorsDays: true, away: true, hours: 0 };
  if (fromPhotos || activity) return { meeting: false, evening: false, outdoorsDays: true, away: false, hours: 0 };
  if (p.allDay === true || e.kind === "birthday" || e.kind === "milestone") return null;
  const ms = e.endAt ? e.endAt.getTime() - e.startAt.getTime() : 3_600_000;
  if (ms <= 0 || ms >= 20 * 3_600_000) return null;
  const { hour, weekday } = localClock(e.startAt, tz);
  return { meeting: true, evening: hour >= 18 || weekday === 0 || weekday === 6, outdoorsDays: false, away: false, hours: Math.round((ms / 3_600_000) * 10) / 10 };
}

/** Days past due without being done (one day of grace), or marked missed. Null when it wasn't late. */
export function lateAt(props: Record<string, unknown>, now: Date): Date | null {
  const due = typeof props.dueAt === "string" ? new Date(props.dueAt) : null;
  if (!due || Number.isNaN(due.getTime())) return null;
  const status = props.status;
  const done = typeof props.doneAt === "string" ? new Date(props.doneAt) : null;
  if (status === "missed") return due;
  if (status === "cancelled") return null;
  if (status === "open" && due.getTime() + 86_400_000 < now.getTime()) return due;
  if (status === "done" && done && done.getTime() > due.getTime() + 86_400_000) return due;
  return null;
}

/** A small en+da word list for the tone of a person's own notes (used when the local model isn't reachable). */
const BRIGHT = ["glad", "happy", "great", "lovely", "good", "fun", "calm", "rested", "grateful", "proud", "enjoyed", "wonderful", "dejlig", "godt", "sjov", "rolig", "udhvilet", "taknemmelig", "stolt", "skøn", "hyggelig", "nød"];
const HEAVY = ["tired", "exhausted", "sad", "awful", "bad", "worried", "stressed", "overwhelmed", "lonely", "angry", "hard", "træt", "udmattet", "ked af", "trist", "dårlig", "bekymret", "stresset", "overvældet", "ensom", "vred", "svært", "hårdt"];

/** -1 … 1 from word counts, or null when the text carries no tone words. */
export function lexiconTone(text: string): number | null {
  const t = ` ${text.toLowerCase()} `;
  const count = (ws: string[]) => ws.reduce((n, w) => n + (t.match(new RegExp(`(?<![\\p{L}])${w}(?![\\p{L}])`, "gu"))?.length ?? 0), 0);
  const b = count(BRIGHT), h = count(HEAVY);
  if (!b && !h) return null;
  return (b - h) / (b + h);
}

function refsByWeek(points: { at: Date | string; ref?: Ref | null }[], s: Series, tz: string): Map<string, Ref[]> {
  const m = new Map<string, Ref[]>();
  const weeks = new Set(s.weeks);
  for (const p of points) {
    if (!p.ref) continue;
    const key = weekOf(p.at, tz);
    if (!weeks.has(key)) continue;
    const list = m.get(key) ?? [];
    if (list.length < 4 && !list.some((r) => r.href === p.ref!.href)) list.push(p.ref);
    m.set(key, list);
  }
  return m;
}

export type Raw = {
  events: EventRow[];
  contacts: ContactRow[];
  commitments: CommitmentRow[];
  mood: MoodRow[];
  docs: DocRow[];
};

/** Build every signal over the weeks from `fromWeek` to `toWeek`. */
export function buildSignals(raw: Raw, opts: { fromWeek: string; toWeek: string; tz: string; now: Date; graphKind: string; topPeople?: number }): SignalSet {
  const { tz } = opts;
  const range = { fromWeek: opts.fromWeek, toWeek: opts.toWeek, tz };
  const pts: Record<SignalKey, Point[]> = { contact: [], meetings: [], evenings: [], outdoors: [], away: [], mood: [], commitments: [], overdue: [], reading: [], workload: [] };
  const ref = (href: string | null, title: string): Ref | null => (href ? { href, title } : null);

  for (const e of raw.events) {
    const c = classifyEvent(e, tz);
    if (!c) continue;
    const r = ref(e.href, e.label);
    if (c.meeting) {
      pts.meetings.push({ at: e.startAt, ref: r });
      if (c.evening) pts.evenings.push({ at: e.startAt, ref: r });
      if (opts.graphKind === "work") pts.workload.push({ at: e.startAt, ref: r });
    }
    if (c.outdoorsDays) for (const d of spanDays(e.startAt, e.endAt, tz, r)) pts.outdoors.push(d);
    if (c.away) for (const d of spanDays(e.startAt, e.endAt, tz, r)) pts.away.push(d);
  }
  for (const c of raw.contacts) pts.contact.push({ at: c.at, ref: ref(c.href, c.title) });
  for (const c of raw.commitments) {
    const r = ref(c.href, c.label);
    pts.commitments.push({ at: c.createdAt, ref: r });
    // Counted in the week it was said yes to, so "more than you can manage in November" is about November.
    if (lateAt(c.props, opts.now)) pts.overdue.push({ at: c.createdAt, ref: r });
  }
  for (const m of raw.mood) pts.mood.push({ at: m.at, value: Math.max(-1, Math.min(1, m.value)), ref: ref(m.href, m.title) });
  for (const d of raw.docs) {
    const r = ref(d.href, d.title);
    if (d.work && opts.graphKind === "work") pts.workload.push({ at: d.at, ref: r });
    else if (!d.work) pts.reading.push({ at: d.at, ref: r });
  }

  const series: SignalSet["series"] = {};
  const refs: SignalSet["refs"] = {};
  for (const key of Object.keys(pts) as SignalKey[]) {
    if (key === "workload" && opts.graphKind !== "work") continue;
    const agg = key === "mood" ? "mean" : key === "outdoors" || key === "away" ? "days" : "sum";
    const s = weekly(key, pts[key], { ...range, agg });
    series[key] = s;
    refs[key] = refsByWeek(pts[key], s, tz);
  }

  // The people the person is most in touch with, each with their own weekly series.
  const byPerson = new Map<string, { name: string; points: Point[] }>();
  for (const c of raw.contacts) {
    const cur = byPerson.get(c.personId) ?? { name: c.name, points: [] };
    cur.points.push({ at: c.at, ref: ref(c.href, c.title) });
    byPerson.set(c.personId, cur);
  }
  const people: PersonSeries[] = [...byPerson].sort((a, b) => b[1].points.length - a[1].points.length).slice(0, opts.topPeople ?? 12)
    .map(([id, p]) => {
      const s = weekly(`person:${id}`, p.points, range);
      return { id, name: p.name, series: s, refs: refsByWeek(p.points, s, tz) };
    });
  return { series, refs, people, graphKind: opts.graphKind };
}
