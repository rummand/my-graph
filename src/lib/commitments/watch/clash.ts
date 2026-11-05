/**
 * Clashes in time (pure, deterministic, no model). For every person, the things they must be at — appointments
 * among the open commitments, and events (school trips, matches, calendar events, meetings) — are compared pairwise:
 *
 *   overlap      the same person is needed in two places at once
 *   travel       back to back, but the places (when both are known) are too far apart for the gap between them
 *   nobody_free  a child's appointment needs a grown-up, and every parent is already booked then
 *
 * What it finds is proposed as a `clashes_with` edge with both receipts and a plain sentence (see `explainClash`).
 */
import { dayIn, norm } from "./text";

export type Slot = {
  id: string;
  label: string;
  start: Date;
  end: Date | null;
  /** A whole day (no time of day known). Only "presence" all-day things (a trip, a camp, a tournament) can clash. */
  allDay: boolean;
  /** Who must be there. */
  people: string[];
  place?: { lat: number; lon: number; label?: string | null } | null;
  origin: "commitment" | "event";
  /** All-day thing that takes the person away for the day (trip, camp, holiday, tournament). */
  presence?: boolean;
  /** A child's appointment that needs a grown-up with them. */
  needsAdult?: boolean;
  ownerId?: string;
  /** Where it was read from, for the receipt. */
  sourceId?: string | null;
  quote?: string | null;
};

export type ClashKind = "overlap" | "travel" | "nobody_free";

export type Clash = {
  key: string;
  kind: ClashKind;
  a: Slot;
  b: Slot;
  /** The people the clash is about (who are double-booked; for nobody_free: the child). */
  personIds: string[];
  /** nobody_free: what each parent is booked with (one per parent). */
  blockers?: { personId: string; slot: Slot }[];
  /** travel: minutes between them, and the minutes the trip needs. */
  gapMinutes?: number;
  travelMinutes?: number;
};

export type ClashOptions = {
  now: Date;
  /** Look this many days ahead (default 60). */
  horizonDays?: number;
  tz?: string;
  /** child id → parent ids (from parent_of edges). */
  caretakers?: Record<string, string[]>;
  /** Pairs already known to belong together (same event twice, one arises from the other): "idA|idB" sorted. */
  related?: Set<string>;
  /** Average door-to-door speed for the travel check, km/h (default 40), and a buffer in minutes (default 10). */
  speedKmh?: number;
  bufferMinutes?: number;
};

const DEFAULT_MINUTES = 60;
const MIN = 60_000;
const DAY = 86_400_000;

/** Words that make an all-day thing take the person away for the day. */
export const PRESENCE_WORDS = /\b(tur|udflugt|lejrskole|lejr|ekskursion|rejse|ferie|stævne|turnering|kamp|cup|trip|outing|excursion|camp|holiday|vacation|journey|tournament|match|away day|field trip|school trip|skoletur|klassetur|hyttetur)\b/i;
/** Words that make a child's thing need a grown-up. */
export const ADULT_WORDS = /\b(tandlæge|tandeftersyn|eftersyn|tandpleje|børnetandpleje|læge|lægen|kontrol|undersøgelse|sygehus|hospital|skolelæge|sundhedsplejerske|vaccin\w*|frisør|optiker|øjenlæge|psykolog|fysioterapeut|forældremøde|skole-hjem|samtale|dentist|doctor|gp|clinic|vaccination|optician|appointment|consultation|check-?up|parent[- ]teacher|hairdresser)\b/i;

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Interval of a slot in ms; all-day slots span their local day(s). */
function span(s: Slot, tz: string): [number, number] {
  if (s.allDay) {
    const startDay = dayIn(s.start, tz);
    const endDay = s.end ? dayIn(s.end, tz) : startDay;
    return [Date.parse(`${startDay}T00:00:00Z`) - tzOffsetMs(s.start, tz), Date.parse(`${endDay}T00:00:00Z`) - tzOffsetMs(s.end ?? s.start, tz) + DAY];
  }
  const a = s.start.getTime();
  const b = s.end && s.end.getTime() > a ? s.end.getTime() : a + DEFAULT_MINUTES * MIN;
  return [a, b];
}

/** The time zone's offset from UTC at an instant, in ms (Copenhagen in winter: +3 600 000). */
export function tzOffsetMs(at: Date, tz: string): number {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(at);
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), g("second"));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Minutes to get from one place to the other (straight line × 1.3 for roads, at `speedKmh`), at least 5. */
export function travelMinutes(a: { lat: number; lon: number }, b: { lat: number; lon: number }, speedKmh = 40): number {
  return Math.max(5, Math.round(((distanceKm(a, b) * 1.3) / speedKmh) * 60));
}

/** The same thing twice (an event and the appointment read from the same letter): same words, same time. */
function sameThing(a: Slot, b: Slot): boolean {
  if (Math.abs(a.start.getTime() - b.start.getTime()) > 60 * MIN) return false;
  const wa = new Set(norm(a.label).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2));
  const wb = norm(b.label).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2);
  if (!wa.size || !wb.length) return norm(a.label) === norm(b.label);
  const shared = wb.filter((w) => wa.has(w)).length;
  return shared / Math.min(wa.size, wb.length) >= 0.6;
}

/** Can this slot clash at all? A plain all-day thing (a birthday, a deadline day) can't. */
function counts(s: Slot): boolean {
  return !s.allDay || !!s.presence;
}

/** Every clash among `slots`, at most one per pair (people merged), sorted by when. */
export function findClashes(slots: Slot[], opts: ClashOptions): Clash[] {
  const tz = opts.tz ?? "Europe/Copenhagen";
  const now = opts.now.getTime();
  const horizon = now + (opts.horizonDays ?? 60) * DAY;
  const speed = opts.speedKmh ?? 40, buffer = opts.bufferMinutes ?? 10;
  const live = slots.filter((s) => counts(s)).map((s) => ({ s, iv: span(s, tz) })).filter(({ iv }) => iv[1] > now && iv[0] < horizon);
  const byKey = new Map<string, Clash>();

  const add = (c: Clash) => {
    const prev = byKey.get(c.key);
    if (prev) prev.personIds = [...new Set([...prev.personIds, ...c.personIds])];
    else byKey.set(c.key, c);
  };

  // 1–2. The same person in two places.
  const byPerson = new Map<string, typeof live>();
  for (const x of live) for (const p of new Set(x.s.people)) (byPerson.get(p) ?? byPerson.set(p, []).get(p)!).push(x);
  for (const [person, list] of byPerson) {
    list.sort((x, y) => x.iv[0] - y.iv[0]);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const A = list[i], B = list[j];
        if (A.s.id === B.s.id) continue;
        const pk = pairKey(A.s.id, B.s.id);
        if (opts.related?.has(pk) || sameThing(A.s, B.s)) continue;
        const gap = B.iv[0] - A.iv[1];
        if (gap > 3 * 60 * MIN) break; // sorted by start: nothing later is closer than this
        if (A.iv[0] < B.iv[1] && B.iv[0] < A.iv[1]) {
          // Two all-day things on the same day are only a clash when both take the person away.
          add({ key: `overlap:${pk}`, kind: "overlap", a: A.s, b: B.s, personIds: [person] });
          continue;
        }
        if (gap >= 0 && !A.s.allDay && !B.s.allDay && A.s.place && B.s.place && distanceKm(A.s.place, B.s.place) > 1) {
          const need = travelMinutes(A.s.place, B.s.place, speed);
          const gapMin = Math.round(gap / MIN);
          if (gapMin < need + buffer) add({ key: `travel:${pk}`, kind: "travel", a: A.s, b: B.s, personIds: [person], gapMinutes: gapMin, travelMinutes: need });
        }
      }
    }
  }

  // 3. A child's appointment with no grown-up free.
  const care = opts.caretakers ?? {};
  for (const C of live) {
    if (!C.s.needsAdult) continue;
    for (const child of C.s.people) {
      const parents = (care[child] ?? []).filter((p) => p !== child);
      if (!parents.length || parents.some((p) => C.s.people.includes(p))) continue;
      const blockers: { personId: string; slot: Slot }[] = [];
      for (const p of parents) {
        const busy = (byPerson.get(p) ?? []).find((B) => B.s.id !== C.s.id && !opts.related?.has(pairKey(B.s.id, C.s.id)) && !sameThing(B.s, C.s)
          && B.iv[0] < C.iv[1] && C.iv[0] < B.iv[1]);
        if (!busy) break;
        blockers.push({ personId: p, slot: busy.s });
      }
      if (blockers.length !== parents.length) continue;
      const ids = [C.s.id, ...blockers.map((b) => b.slot.id)].sort();
      add({ key: `nobody_free:${C.s.id}:${ids.join("|")}`, kind: "nobody_free", a: C.s, b: blockers[0].slot, personIds: [child], blockers });
    }
  }

  return [...byKey.values()].sort((x, y) => x.a.start.getTime() - y.a.start.getTime() || x.key.localeCompare(y.key));
}

/* ── Plain words ─────────────────────────────────────────────────────────────────────────────────────── */

export type WatchLocale = "en" | "da";

function fmt(locale: WatchLocale, tz: string, o: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat(locale === "da" ? "da-DK" : "en-GB", { timeZone: tz, ...o });
}

/** "Thu 9:00–15:00", "Thu 10:30", "Thu 12 Nov" (all day). */
export function whenText(s: Slot, locale: WatchLocale, tz: string, withDay = true): string {
  const day = fmt(locale, tz, { weekday: "short", day: "numeric", month: "short" }).format(s.start);
  if (s.allDay) return day;
  const t = fmt(locale, tz, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const range = s.end && s.end.getTime() > s.start.getTime() ? `${t.format(s.start)}–${t.format(s.end)}` : t.format(s.start);
  return withDay ? `${day} ${range}` : range;
}

function names(ids: string[], nameOf: (id: string) => string, locale: WatchLocale): string {
  const n = ids.map(nameOf);
  if (n.length <= 1) return n[0] ?? "";
  return `${n.slice(0, -1).join(", ")} ${locale === "da" ? "og" : "and"} ${n[n.length - 1]}`;
}

/** One plain sentence about a clash, in the reader's language. */
export function explainClash(c: Clash, nameOf: (id: string) => string, locale: WatchLocale, tz = "Europe/Copenhagen"): string {
  const q = (s: string) => (locale === "da" ? `„${s}“` : `“${s}”`);
  const who = names(c.personIds, nameOf, locale);
  if (c.kind === "overlap") {
    const sameDay = dayIn(c.a.start, tz) === dayIn(c.b.start, tz);
    return locale === "da"
      ? `${who}: ${q(c.a.label)} (${whenText(c.a, locale, tz)}) falder sammen med ${q(c.b.label)} (${whenText(c.b, locale, tz, !sameDay)}).`
      : `${who}: ${q(c.a.label)} (${whenText(c.a, locale, tz)}) clashes with ${q(c.b.label)} (${whenText(c.b, locale, tz, !sameDay)}).`;
  }
  if (c.kind === "travel") {
    const t = fmt(locale, tz, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    const endA = c.a.end ?? new Date(c.a.start.getTime() + DEFAULT_MINUTES * MIN);
    return locale === "da"
      ? `${who} har kun ${c.gapMinutes} minutter fra ${q(c.a.label)} (slutter ${t.format(endA)}) til ${q(c.b.label)} (${t.format(c.b.start)}), og turen tager omkring ${c.travelMinutes} minutter.`
      : `${who} has only ${c.gapMinutes} minutes from ${q(c.a.label)} (ends ${t.format(endA)}) to ${q(c.b.label)} (${t.format(c.b.start)}), and the trip takes about ${c.travelMinutes} minutes.`;
  }
  const busy = (c.blockers ?? []).map((b) => `${nameOf(b.personId)}: ${q(b.slot.label)}`).join("; ");
  const parents = names((c.blockers ?? []).map((b) => b.personId), nameOf, locale);
  const both = (c.blockers ?? []).length === 2;
  return locale === "da"
    ? `${q(c.a.label)} for ${who} (${whenText(c.a, locale, tz)}) kræver en voksen, men ${parents} er ${both ? "begge " : ""}optaget (${busy}).`
    : `${q(c.a.label)} for ${who} (${whenText(c.a, locale, tz)}) needs a grown-up, but ${parents} ${both ? "are both" : (c.blockers ?? []).length > 1 ? "are all" : "is"} booked (${busy}).`;
}
