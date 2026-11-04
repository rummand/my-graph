import { differenceInCalendarDays, format, isSameMonth, isSameYear, startOfDay } from "date-fns";
import { lookup, type Locale, type TFn } from "@/lib/i18n/core";
import { dateLocale } from "@/lib/i18n/dates";
import enChat from "@/lib/i18n/messages/en/chat";
import { EN_T } from "./words";

/** Pure helpers for the Ask screen: grouping conversations by recency, starter questions, source labels. */

export type Dated = { id: string; updatedAt: string };
export type Group<T> = { key: string; label: string; items: T[] };
export type Words = { t?: TFn; locale?: Locale };

/** "Today", "Yesterday", "Earlier this week", "Earlier this month", then one group per month ("October", "March 2025"). */
export function groupByRecency<T extends Dated>(list: T[], now: Date = new Date(), words: Words = {}): Group<T>[] {
  const groups = new Map<string, Group<T>>();
  const sorted = [...list].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  for (const c of sorted) {
    const d = new Date(c.updatedAt);
    const { key, label } = bucket(Number.isNaN(d.getTime()) ? now : d, now, words);
    if (!groups.has(key)) groups.set(key, { key, label, items: [] });
    groups.get(key)!.items.push(c);
  }
  return [...groups.values()];
}

/** The inbox: pinned conversations first (most recently pinned order kept by update time), then by recency. */
export function groupForInbox<T extends Dated & { pinned?: boolean }>(list: T[], now: Date = new Date(), words: Words = {}): Group<T>[] {
  const t = words.t ?? EN_T;
  const pinned = list.filter((c) => c.pinned).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const rest = groupByRecency(list.filter((c) => !c.pinned), now, words);
  return pinned.length ? [{ key: "pinned", label: t("chat.groups.pinned"), items: pinned }, ...rest] : rest;
}

const capital = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function bucket(d: Date, now: Date, { t = EN_T, locale = "en" }: Words): { key: string; label: string } {
  const days = differenceInCalendarDays(startOfDay(now), startOfDay(d));
  if (days <= 0) return { key: "today", label: t("chat.groups.today") };
  if (days === 1) return { key: "yesterday", label: t("chat.groups.yesterday") };
  if (days < 7) return { key: "week", label: t("chat.groups.week") };
  if (isSameMonth(d, now)) return { key: "month", label: t("chat.groups.month") };
  const loc = { locale: dateLocale(locale) };
  if (isSameYear(d, now)) return { key: format(d, "yyyy-MM"), label: capital(format(d, "LLLL", loc)) };
  return { key: format(d, "yyyy-MM"), label: capital(format(d, "LLLL yyyy", loc)) };
}

export type FamilyMember = { id: string; name: string; kind: string | null };
export type Starter = { question: string; person?: { id: string; name: string } };

const first = (name: string) => name.trim().split(/\s+/)[0] || name;

/** Questions a family is likely to ask, written around its own people. Children first, then the household. */
export function starterQuestions(family: FamilyMember[], t: TFn = EN_T): Starter[] {
  const kids = family.filter((p) => p.kind === "child");
  const partner = family.find((p) => p.kind === "partner");
  const out: Starter[] = [];
  const q = (k: string, name?: string) => t(`chat.starters.family.${k}`, name ? { name } : undefined);
  const [a, b] = kids;
  if (a) out.push({ question: q("comingUp", first(a.name)), person: { id: a.id, name: a.name } });
  if (b) out.push({ question: q("checkUp", first(b.name)), person: { id: b.id, name: b.name } });
  else if (a) out.push({ question: q("bring", first(a.name)), person: { id: a.id, name: a.name } });
  if (partner) out.push({ question: q("weekend", first(partner.name)), person: { id: partner.id, name: partner.name } });
  out.push({ question: q("slips") });
  out.push({ question: q("aula") });
  if (out.length < 5) out.push({ question: q("reminders") });
  return out.slice(0, 5);
}

/**
 * Starter questions for a graph that isn't a family graph: the template's example prompts, translated when our
 * English copy still matches the template's text (so a changed template never shows a stale translation).
 */
export function templateStarters(kind: string, prompts: string[], t: TFn = EN_T): Starter[] {
  const list = prompts.length ? prompts : [0, 1, 2].map((i) => EN_T(`chat.starters.generic.${i}`));
  const keyKind = prompts.length ? kind : "generic";
  return list.slice(0, 5).map((p, i) => {
    const key = `starters.${keyKind}.${i}`;
    return { question: lookup(enChat, key) === p ? t(`chat.${key}`, undefined, p) : p };
  });
}

/** The short name of a model id like "mac-studio/qwen3.6-35b-a3b". */
export function shortModel(model: string | null | undefined): string | null {
  if (!model) return null;
  const tail = model.split("/").pop() ?? model;
  return tail || null;
}

/** Where a citation points inside its source, in words: "page 3", "at 1:20". */
export function locatorWords(l: { page?: number; timeStartSec?: number; timeEndSec?: number } | undefined | null, t: TFn = EN_T): string | null {
  if (!l) return null;
  if (typeof l.page === "number") return t("chat.sources.page", { n: l.page });
  if (typeof l.timeStartSec === "number") {
    const ts = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
    return typeof l.timeEndSec === "number" ? t("chat.sources.range", { from: ts(l.timeStartSec), to: ts(l.timeEndSec) }) : t("chat.sources.at", { t: ts(l.timeStartSec) });
  }
  return null;
}
