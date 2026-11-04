/**
 * The Heartbeat's deterministic checks turned into proposals (pure, tested). The check-in reads what changed and
 * what is coming, then only proposes: nudges to look at something, reminders to approve, facts to confirm.
 */
import type { Citation } from "@/db/schema";
import type { SuggestionKind } from "./index";
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

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (xs: string[], max = 3) => (xs.length <= max ? joinAnd(xs) : `${xs.slice(0, max).join(", ")} and ${xs.length - max} more`);
function joinAnd(xs: string[]) {
  return xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
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

export function buildHeartbeatProposals(
  d: HeartbeatData, opts: { now: Date; tz: string; capabilities: Record<string, boolean>; birthdayFreeMinute?: Record<string, number | null> },
): Proposal[] {
  const out: Proposal[] = [];
  const cap = (k: string) => opts.capabilities[k] !== false;
  const { now } = opts;

  // Overdue reminders first: they are the most pressing.
  if (cap("reminders") && d.overdue.length) {
    const titles = d.overdue.map((r) => r.title);
    out.push({
      kind: "nudge", title: d.overdue.length === 1 ? `Overdue: ${d.overdue[0].title}` : `${plural(d.overdue.length, "reminder")} are overdue`,
      body: d.overdue.length === 1 ? null : `${list(titles)}. Tick them off on Today, or move them to a new date.`,
      payload: { href: "/", label: "Open Today" }, citations: [], dedupeKey: `hb:overdue#${setKey(d.overdue.map((r) => r.id))}`,
    });
  }

  if (cap("reminders") && d.dueSoon.length) {
    const titles = d.dueSoon.map((r) => (r.aboutLabel ? `${r.title} (${r.aboutLabel})` : r.title));
    out.push({
      kind: "nudge", title: d.dueSoon.length === 1 ? `Due in the next two days: ${d.dueSoon[0].title}` : `${plural(d.dueSoon.length, "thing")} due in the next two days`,
      body: d.dueSoon.length === 1 ? (d.dueSoon[0].aboutLabel ? `For ${d.dueSoon[0].aboutLabel}.` : null) : `${list(titles)}.`,
      payload: { href: "/", label: "Open Today" }, citations: [], dedupeKey: `hb:due#${setKey(d.dueSoon.map((r) => r.id))}`,
    });
  }

  if (cap("library") && d.uploads.length) {
    const titles = d.uploads.map((u) => quoteTitle(u.title));
    out.push({
      kind: "nudge", title: d.uploads.length === 1 ? `New in the library: ${d.uploads[0].title}` : `${plural(d.uploads.length, "new file")} in the library`,
      body: d.uploads.length === 1 ? "Have a look for dates or things to do." : `${list(titles)}. Have a look for dates or things to do.`,
      payload: { href: d.uploads.length === 1 ? `/library/${d.uploads[0].id}` : "/library", label: "Open the library" },
      citations: d.uploads.slice(0, 4).map((u, i) => ({ n: i + 1, sourceId: u.id, title: u.title })),
      dedupeKey: `hb:uploads#${setKey(d.uploads.map((u) => u.id))}`,
    });
  }

  if (cap("people") && cap("reminders")) {
    for (const b of d.birthdays.filter((x) => x.daysUntil <= BIRTHDAY_DAYS)) {
      const year = localParts(b.date, opts.tz).year;
      const when = b.daysUntil === 0 ? "today" : b.daysUntil === 1 ? "tomorrow" : `in ${b.daysUntil} days`;
      const turning = b.turning ? `, turning ${b.turning}` : "";
      const title = `${b.label}'s birthday`;
      const already = d.reminderTitles.some((t) => t.includes(b.label.toLowerCase()) && (t.includes("birthday") || t.includes("fødselsdag")));
      if (b.daysUntil <= 1 || already) {
        out.push({
          kind: "nudge", title: `${b.label}'s birthday is ${when}${turning}`, body: null,
          payload: { href: `/people/${b.personId}`, label: `Open ${b.label}` }, citations: [{ n: 1, nodeId: b.personId, title: b.label }],
          dedupeKey: `hb:bday:${b.personId}:${year}`,
        });
      } else {
        out.push({
          kind: "reminder", title: `Add a reminder for ${title}`, body: `${b.label}'s birthday is ${when}${turning}. A reminder the day before leaves time for a present or a call.`,
          payload: { title: `${title}${turning ? ` (${b.turning})` : ""}: present or call`, dueAt: birthdayReminderAt(b.date, opts.tz, opts.birthdayFreeMinute?.[b.personId]), aboutNodeId: b.personId },
          citations: [{ n: 1, nodeId: b.personId, title: b.label }], dedupeKey: `hb:bday:${b.personId}:${year}`,
        });
      }
    }
  }

  if (cap("people")) {
    const month = `${localParts(now, opts.tz).year}-${localParts(now, opts.tz).month}`;
    for (const p of d.outOfTouch.slice(0, 2)) {
      out.push({
        kind: "nudge", title: `It's been a while since you were in touch with ${p.label}`,
        body: p.daysSince !== null ? `${p.daysSince} days since you were last in touch; usually it's about every ${p.cadenceDays} days.` : `Nothing logged yet, and they've been in the graph for over ${p.cadenceDays} days.`,
        payload: { href: `/people/${p.personId}`, label: `Open ${p.label}` }, citations: [{ n: 1, nodeId: p.personId, title: p.label }],
        dedupeKey: `hb:contact:${p.personId}:${month}`,
      });
    }
  }

  if (d.facts.edges.length) {
    for (const e of d.facts.edges.slice(0, MAX_FACTS_PER_CHECKIN)) {
      out.push({
        kind: "fact", title: `Is this right? ${e.fromLabel} ${e.relationLabel} ${e.toLabel}`,
        body: e.sourceTitle ? `Read from ${quoteTitle(e.sourceTitle)}; nobody has checked it yet.` : "Nobody has checked this yet.",
        payload: { edgeId: e.id }, dedupeKey: `hb:fact:${e.id}`,
        citations: [e.sourceId ? { n: 1, sourceId: e.sourceId, title: e.sourceTitle ?? "Source", confidence: e.confidence } : { n: 1, nodeId: e.fromId, title: e.fromLabel, confidence: e.confidence }],
      });
    }
    const rest = d.facts.total - Math.min(d.facts.edges.length, MAX_FACTS_PER_CHECKIN);
    if (rest > 0) {
      out.push({
        kind: "nudge", title: `${plural(rest, "more fact")} waiting to be checked`, body: "They were read from your files or guessed by the assistant. Confirm or correct them from each person's page.",
        payload: { href: `/node/${d.facts.edges[0].fromId}`, label: "Start checking" }, citations: [], dedupeKey: `hb:facts#${Math.floor(rest / 10)}`,
      });
    }
  }
  return out;
}

/** The one plain sentence for the run log when the model summary isn't available. */
export function heartbeatSummary(created: number, held: number, data: HeartbeatData): string {
  const bits: string[] = [];
  if (data.overdue.length) bits.push(`${plural(data.overdue.length, "overdue reminder")}`);
  if (data.dueSoon.length) bits.push(`${plural(data.dueSoon.length, "thing")} due soon`);
  if (data.uploads.length) bits.push(`${plural(data.uploads.length, "new file")}`);
  const bdays = data.birthdays.filter((b) => b.daysUntil <= BIRTHDAY_DAYS).length;
  if (bdays) bits.push(`${plural(bdays, "birthday")} this week`);
  if (data.outOfTouch.length) bits.push(`${plural(data.outOfTouch.length, "person", "people")} to get in touch with`);
  if (data.facts.total) bits.push(`${plural(data.facts.total, "fact")} to check`);
  if (!bits.length) return "Nothing needs you right now.";
  const tail = created ? ` Added ${plural(created, "suggestion")} to your inbox.` : " Nothing new for your inbox.";
  return `Found ${joinAnd(bits)}.${tail}${held ? ` Held back ${held} (today's limit).` : ""}`;
}
