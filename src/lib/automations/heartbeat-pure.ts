/**
 * The Heartbeat's deterministic checks turned into proposals (pure, tested). The check-in reads what changed and
 * what is coming, then only proposes: nudges to look at something, reminders to approve, facts to confirm.
 */
import type { Citation } from "@/db/schema";
import type { SuggestionKind } from "./index";
import { makeT, type TFn } from "@/lib/i18n/core";
import { DICTIONARIES } from "@/lib/i18n/messages";
import { localParts, zonedTime } from "./schedule";

export type HeartbeatData = {
  uploads: { id: string; title: string; createdAt: Date }[];
  dueSoon: { id: string; title: string; dueAt: Date; aboutLabel: string | null }[];
  overdue: { id: string; title: string; dueAt: Date; aboutLabel: string | null }[];
  birthdays: { personId: string; label: string; date: Date; daysUntil: number; turning: number | null }[];
  outOfTouch: { personId: string; label: string; daysSince: number | null; cadenceDays: number }[];
  facts: { edges: { id: string; fromId: string; fromLabel: string; toLabel: string; relationLabel: string; confidence: number; sourceId: string | null; sourceTitle: string | null }[]; total: number };
  /** Open reminder titles, lower-cased, so it doesn't propose one that already exists. */
  reminderTitles: string[];
};

export type Proposal = {
  kind: SuggestionKind; title: string; body: string | null; payload: Record<string, unknown>; citations: Citation[]; dedupeKey: string;
};

export const BIRTHDAY_DAYS = 7;
export const DUE_HOURS = 48;
export const MAX_FACTS_PER_CHECKIN = 2;

const EN: TFn = makeT("en", DICTIONARIES.en);
const H = "automations.server.heartbeat";
const list = (xs: string[], t: TFn, max = 3) => (xs.length <= max ? joinAnd(xs, t) : t(`${H}.andMore`, { list: xs.slice(0, max).join(", "), count: xs.length - max }));
function joinAnd(xs: string[], t: TFn) {
  return xs.length <= 1 ? xs.join("") : t("chat.steps.and", { a: xs.slice(0, -1).join(", "), b: xs[xs.length - 1] });
}
const quoteTitle = (t: string) => `“${t.length > 60 ? `${t.slice(0, 57)}…` : t}”`;
/** Stable short id for a set of ids (for group keys). */
export function setKey(ids: string[]): string {
  let h = 0;
  for (const c of [...ids].sort().join(",")) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * A morning reminder the day before a birthday, at 09:00 local (or the first free hour when the day is busy;
 * tentative events count as busy). Returns an ISO instant.
 */
export function birthdayReminderAt(date: Date, tz: string, freeMinute: number | null = 9 * 60): string {
  const p = localParts(date, tz);
  const dayBefore = new Date(Date.UTC(p.year, p.month - 1, p.day - 1));
  const m = freeMinute ?? 9 * 60;
  return zonedTime(dayBefore.getUTCFullYear(), dayBefore.getUTCMonth() + 1, dayBefore.getUTCDate(), Math.floor(m / 60), m % 60, tz).toISOString();
}

/**
 * `t` is the owner's language (tFor(users.locale)): every title and body is written in it and stored as is.
 */
export function buildHeartbeatProposals(
  d: HeartbeatData, opts: { now: Date; tz: string; capabilities: Record<string, boolean>; birthdayFreeMinute?: Record<string, number | null>; t?: TFn },
): Proposal[] {
  const out: Proposal[] = [];
  const t = opts.t ?? EN;
  const cap = (k: string) => opts.capabilities[k] !== false;
  const { now } = opts;
  const today = t(`${H}.openToday`);

  // Overdue reminders first: they are the most pressing.
  if (cap("reminders") && d.overdue.length) {
    const titles = d.overdue.map((r) => r.title);
    out.push({
      kind: "nudge", title: d.overdue.length === 1 ? t(`${H}.overdueOne`, { title: d.overdue[0].title }) : t(`${H}.overdueMany`, { count: d.overdue.length }),
      body: d.overdue.length === 1 ? null : t(`${H}.overdueBody`, { list: list(titles, t) }),
      payload: { href: "/", label: today }, citations: [], dedupeKey: `hb:overdue#${setKey(d.overdue.map((r) => r.id))}`,
    });
  }

  if (cap("reminders") && d.dueSoon.length) {
    const titles = d.dueSoon.map((r) => (r.aboutLabel ? `${r.title} (${r.aboutLabel})` : r.title));
    out.push({
      kind: "nudge", title: d.dueSoon.length === 1 ? t(`${H}.dueOne`, { title: d.dueSoon[0].title }) : t(`${H}.dueMany`, { count: d.dueSoon.length }),
      body: d.dueSoon.length === 1 ? (d.dueSoon[0].aboutLabel ? t(`${H}.dueFor`, { who: d.dueSoon[0].aboutLabel }) : null) : `${list(titles, t)}.`,
      payload: { href: "/", label: today }, citations: [], dedupeKey: `hb:due#${setKey(d.dueSoon.map((r) => r.id))}`,
    });
  }

  if (cap("library") && d.uploads.length) {
    const titles = d.uploads.map((u) => quoteTitle(u.title));
    out.push({
      kind: "nudge", title: d.uploads.length === 1 ? t(`${H}.uploadOne`, { title: d.uploads[0].title }) : t(`${H}.uploadMany`, { count: d.uploads.length }),
      body: d.uploads.length === 1 ? t(`${H}.uploadLook`) : `${list(titles, t)}. ${t(`${H}.uploadLook`)}`,
      payload: { href: d.uploads.length === 1 ? `/library/${d.uploads[0].id}` : "/library", label: t(`${H}.openLibrary`) },
      citations: d.uploads.slice(0, 4).map((u, i) => ({ n: i + 1, sourceId: u.id, title: u.title })),
      dedupeKey: `hb:uploads#${setKey(d.uploads.map((u) => u.id))}`,
    });
  }

  if (cap("people") && cap("reminders")) {
    for (const b of d.birthdays.filter((x) => x.daysUntil <= BIRTHDAY_DAYS)) {
      const year = localParts(b.date, opts.tz).year;
      const when = b.daysUntil === 0 ? t(`${H}.whenToday`) : b.daysUntil === 1 ? t(`${H}.whenTomorrow`) : t(`${H}.whenInDays`, { count: b.daysUntil });
      const turning = b.turning ? t(`${H}.turning`, { age: b.turning }) : "";
      const already = d.reminderTitles.some((x) => x.includes(b.label.toLowerCase()) && (x.includes("birthday") || x.includes("fødselsdag")));
      const open = t(`${H}.openPerson`, { name: b.label });
      if (b.daysUntil <= 1 || already) {
        out.push({
          kind: "nudge", title: t(`${H}.birthdayIs`, { name: b.label, when, turning }), body: null,
          payload: { href: `/people/${b.personId}`, label: open }, citations: [{ n: 1, nodeId: b.personId, title: b.label }],
          dedupeKey: `hb:bday:${b.personId}:${year}`,
        });
      } else {
        out.push({
          kind: "reminder", title: t(`${H}.birthdayAdd`, { name: b.label }),
          body: t(`${H}.birthdayBody`, { name: b.label, when, turning }),
          payload: {
            title: t(b.turning ? `${H}.birthdayReminderAge` : `${H}.birthdayReminder`, { name: b.label, age: b.turning ?? "" }),
            dueAt: birthdayReminderAt(b.date, opts.tz, opts.birthdayFreeMinute?.[b.personId]), aboutNodeId: b.personId,
          },
          citations: [{ n: 1, nodeId: b.personId, title: b.label }], dedupeKey: `hb:bday:${b.personId}:${year}`,
        });
      }
    }
  }

  if (cap("people")) {
    const month = `${localParts(now, opts.tz).year}-${localParts(now, opts.tz).month}`;
    for (const p of d.outOfTouch.slice(0, 2)) {
      out.push({
        kind: "nudge", title: t(`${H}.outOfTouch`, { name: p.label }),
        body: p.daysSince !== null ? t(`${H}.outOfTouchBody`, { days: p.daysSince, cadence: p.cadenceDays }) : t(`${H}.outOfTouchNever`, { cadence: p.cadenceDays }),
        payload: { href: `/people/${p.personId}`, label: t(`${H}.openPerson`, { name: p.label }) }, citations: [{ n: 1, nodeId: p.personId, title: p.label }],
        dedupeKey: `hb:contact:${p.personId}:${month}`,
      });
    }
  }

  if (d.facts.edges.length) {
    for (const e of d.facts.edges.slice(0, MAX_FACTS_PER_CHECKIN)) {
      out.push({
        kind: "fact", title: t(`${H}.factCheck`, { from: e.fromLabel, relation: e.relationLabel, to: e.toLabel }),
        body: e.sourceTitle ? t(`${H}.factFrom`, { source: quoteTitle(e.sourceTitle) }) : t(`${H}.factUnchecked`),
        payload: { edgeId: e.id }, dedupeKey: `hb:fact:${e.id}`,
        citations: [e.sourceId ? { n: 1, sourceId: e.sourceId, title: e.sourceTitle ?? t(`${H}.source`), confidence: e.confidence } : { n: 1, nodeId: e.fromId, title: e.fromLabel, confidence: e.confidence }],
      });
    }
    const rest = d.facts.total - Math.min(d.facts.edges.length, MAX_FACTS_PER_CHECKIN);
    if (rest > 0) {
      out.push({
        kind: "nudge", title: t(`${H}.moreFacts`, { count: rest }), body: t(`${H}.moreFactsBody`),
        payload: { href: `/node/${d.facts.edges[0].fromId}`, label: t(`${H}.startChecking`) }, citations: [], dedupeKey: `hb:facts#${Math.floor(rest / 10)}`,
      });
    }
  }
  return out;
}

/** The one plain sentence for the run log when the model summary isn't available (in the owner's language). */
export function heartbeatSummary(created: number, held: number, data: HeartbeatData, t: TFn = EN): string {
  const bits: string[] = [];
  if (data.overdue.length) bits.push(t(`${H}.sum.overdue`, { count: data.overdue.length }));
  if (data.dueSoon.length) bits.push(t(`${H}.sum.dueSoon`, { count: data.dueSoon.length }));
  if (data.uploads.length) bits.push(t(`${H}.sum.files`, { count: data.uploads.length }));
  const bdays = data.birthdays.filter((b) => b.daysUntil <= BIRTHDAY_DAYS).length;
  if (bdays) bits.push(t(`${H}.sum.birthdays`, { count: bdays }));
  if (data.outOfTouch.length) bits.push(t(`${H}.sum.people`, { count: data.outOfTouch.length }));
  if (data.facts.total) bits.push(t(`${H}.sum.facts`, { count: data.facts.total }));
  if (!bits.length) return t(`${H}.sum.nothing`);
  const tail = created ? t(`${H}.sum.added`, { count: created }) : t(`${H}.sum.nothingNew`);
  return `${t(`${H}.sum.found`, { what: joinAnd(bits, t) })}${tail}${held ? t(`${H}.sum.held`, { count: held }) : ""}`;
}
