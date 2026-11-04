import { differenceInCalendarDays, format, isSameMonth, isSameYear, startOfDay } from "date-fns";

/** Pure helpers for the Ask screen: grouping conversations by recency, starter questions, source labels. */

export type Dated = { id: string; updatedAt: string };
export type Group<T> = { key: string; label: string; items: T[] };

/** "Today", "Yesterday", "Earlier this week", "Earlier this month", then one group per month ("October", "March 2025"). */
export function groupByRecency<T extends Dated>(list: T[], now: Date = new Date()): Group<T>[] {
  const groups = new Map<string, Group<T>>();
  const sorted = [...list].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  for (const c of sorted) {
    const d = new Date(c.updatedAt);
    const { key, label } = bucket(Number.isNaN(d.getTime()) ? now : d, now);
    if (!groups.has(key)) groups.set(key, { key, label, items: [] });
    groups.get(key)!.items.push(c);
  }
  return [...groups.values()];
}

/** The inbox: pinned conversations first (most recently pinned order kept by update time), then by recency. */
export function groupForInbox<T extends Dated & { pinned?: boolean }>(list: T[], now: Date = new Date()): Group<T>[] {
  const pinned = list.filter((c) => c.pinned).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const rest = groupByRecency(list.filter((c) => !c.pinned), now);
  return pinned.length ? [{ key: "pinned", label: "Pinned", items: pinned }, ...rest] : rest;
}

function bucket(d: Date, now: Date): { key: string; label: string } {
  const days = differenceInCalendarDays(startOfDay(now), startOfDay(d));
  if (days <= 0) return { key: "today", label: "Today" };
  if (days === 1) return { key: "yesterday", label: "Yesterday" };
  if (days < 7) return { key: "week", label: "Earlier this week" };
  if (isSameMonth(d, now)) return { key: "month", label: "Earlier this month" };
  if (isSameYear(d, now)) return { key: format(d, "yyyy-MM"), label: format(d, "MMMM") };
  return { key: format(d, "yyyy-MM"), label: format(d, "MMMM yyyy") };
}

export type FamilyMember = { id: string; name: string; kind: string | null };
export type Starter = { question: string; person?: { id: string; name: string } };

const first = (name: string) => name.trim().split(/\s+/)[0] || name;

/** Questions this family is likely to ask, written around its own people. Children first, then the household. */
export function starterQuestions(family: FamilyMember[]): Starter[] {
  const kids = family.filter((p) => p.kind === "child");
  const partner = family.find((p) => p.kind === "partner");
  const out: Starter[] = [];
  const [a, b] = kids;
  if (a) out.push({ question: `What's coming up for ${first(a.name)} this week?`, person: { id: a.id, name: a.name } });
  if (b) out.push({ question: `When was ${first(b.name)}'s last check-up at the doctor?`, person: { id: b.id, name: b.name } });
  else if (a) out.push({ question: `Does ${first(a.name)} need to bring anything to school soon?`, person: { id: a.id, name: a.name } });
  if (partner) out.push({ question: `What has ${first(partner.name)} got on this weekend?`, person: { id: partner.id, name: partner.name } });
  out.push({ question: "Which permission slips are still waiting for a signature?" });
  out.push({ question: "What did the latest Aula letter say?" });
  if (out.length < 5) out.push({ question: "Which reminders are still open?" });
  return out.slice(0, 5);
}

/** The short name of a model id like "mac-studio/qwen3.6-35b-a3b". */
export function shortModel(model: string | null | undefined): string | null {
  if (!model) return null;
  const tail = model.split("/").pop() ?? model;
  return tail || null;
}

/** Where a citation points inside its source, in words: "page 3", "at 1:20". */
export function locatorWords(l: { page?: number; timeStartSec?: number; timeEndSec?: number } | undefined | null): string | null {
  if (!l) return null;
  if (typeof l.page === "number") return `page ${l.page}`;
  if (typeof l.timeStartSec === "number") {
    const t = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
    return typeof l.timeEndSec === "number" ? `${t(l.timeStartSec)} to ${t(l.timeEndSec)}` : `at ${t(l.timeStartSec)}`;
  }
  return null;
}
