/**
 * The assistant's part of Today (pure, unit-tested): who may see it, where each suggestion came from, where an
 * activity entry links to, the questions we offer from the graph's own data, the first-run examples, and the
 * background lines the daily brief gets about pending suggestions and the latest check-in. Every label takes the
 * reader's locale (English by default) and reads the "today" messages.
 */
import type { Role } from "@/lib/graphs/pure";
import type { Locale } from "@/lib/i18n/core";
import { calendarDayDiff, formatDayMonth, formatShortDay, formatTime, weekdayLong, zonedParts } from "./dates";
import { todayT } from "./words";

/* ── Access ───────────────────────────────────────────────────────────────────────────────────────────── */

/** Children and guests never see the inbox, activity, recipes or the assistant's settings. */
export function canUseAssistantTools(v: { role: Role }): boolean {
  return v.role !== "child" && v.role !== "guest";
}

/** Graph viewers can read but not create (no new automations, no deciding suggestions). */
export function canWriteInGraph(v: { graphRole: "owner" | "editor" | "viewer" }): boolean {
  return v.graphRole !== "viewer";
}

/* ── Suggestions ──────────────────────────────────────────────────────────────────────────────────────── */

export type SuggestionOrigin = "chat" | "automation" | "heartbeat" | "ingest";
export type SuggestionKindName = "fact" | "reminder" | "merge" | "rule" | "memory" | "wiki_edit" | "nudge";

function partOfDay(hour: number): "morning" | "afternoon" | "evening" | "night" {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 22) return "evening";
  return "night";
}

/**
 * When a suggestion was made, in the words its origin line uses: "this morning's", "yesterday's", "Monday's"
 * (Danish: "i morges", "i går", "i mandags"), or null when it is older than a week (then the date is used).
 */
function whenWords(at: Date, now: Date, tz: string, locale: Locale): string | null {
  const t = todayT(locale);
  const diff = calendarDayDiff(at, now, tz);
  const p = zonedParts(at, tz);
  if (diff === 0) {
    const part = partOfDay(p.hour);
    return part === "night" ? t(p.hour < 5 ? "today.origin.when.lastNight" : "today.origin.when.tonight") : t(`today.origin.when.${part}`);
  }
  if (diff === -1) return t("today.origin.when.yesterday");
  if (diff > -7) return t("today.origin.when.weekday", { day: weekdayLong(p.weekday, locale) });
  return null;
}

/** Plain words for where a suggestion came from, e.g. "From this morning's check-in". */
export function suggestionOriginLabel(s: { origin: string; createdAt: Date }, now: Date, tz: string, locale: Locale = "en"): string {
  const t = todayT(locale);
  const when = whenWords(s.createdAt, now, tz, locale);
  const date = formatDayMonth(s.createdAt, tz, locale);
  switch (s.origin) {
    case "heartbeat": return when ? t("today.origin.heartbeat", { when }) : t("today.origin.heartbeatOn", { date });
    case "automation": return when ? t("today.origin.automation", { when }) : t("today.origin.automationOn", { date });
    case "chat": return t("today.origin.chat");
    case "ingest": return t("today.origin.ingest");
    default: return t("today.origin.other");
  }
}

/** "New fact", "New reminder", "Family rule" (just "Rule" outside a family graph)… */
export function suggestionKindLabel(kind: string, locale: Locale = "en", graphKind = "family"): string {
  const t = todayT(locale);
  if (kind === "rule") return t(graphKind === "family" ? "today.kind.ruleFamily" : "today.kind.rule");
  const known: SuggestionKindName[] = ["fact", "reminder", "merge", "memory", "wiki_edit", "nudge"];
  return known.includes(kind as SuggestionKindName) ? t(`today.kind.${kind}`) : t("today.kind.other");
}

/** English labels by kind (kept for callers that don't translate yet). */
export const SUGGESTION_KIND_LABEL: Record<SuggestionKindName, string> = {
  fact: suggestionKindLabel("fact"),
  reminder: suggestionKindLabel("reminder"),
  merge: suggestionKindLabel("merge"),
  rule: suggestionKindLabel("rule"),
  memory: suggestionKindLabel("memory"),
  wiki_edit: suggestionKindLabel("wiki_edit"),
  nudge: suggestionKindLabel("nudge"),
};

/**
 * The "Always allow" label for a kind, or undefined when that kind must always be asked about.
 * Facts and merges change what the graph says is true, so they are never allowed without asking.
 */
export function alwaysAllowLabel(kind: string, locale: Locale = "en", graphKind = "family"): string | undefined {
  const t = todayT(locale);
  switch (kind) {
    case "reminder": return t("today.always.reminder");
    case "memory": return t("today.always.memory");
    case "rule": return t(graphKind === "family" ? "today.always.ruleFamily" : "today.always.rule");
    case "wiki_edit": return t("today.always.wiki_edit");
    default: return undefined;
  }
}

const PREVIEW_KEYS = ["title", "text", "label", "relation", "dueAt", "startAt", "about", "detail", "page", "keep", "merge"] as const;

/**
 * The exact preview of what approving would write: the suggestion's own body when it has one, otherwise the known
 * fields of its payload as "Label: value" lines. Dates are formatted in the reader's zone. Never more than 6 lines.
 */
export function suggestionPreview(s: { body: string | null; payload: Record<string, unknown> }, tz: string, locale: Locale = "en"): { label: string | null; value: string }[] {
  if (s.body?.trim()) return [{ label: null, value: s.body.trim() }];
  const t = todayT(locale);
  const out: { label: string | null; value: string }[] = [];
  for (const key of PREVIEW_KEYS) {
    const raw = s.payload?.[key];
    if (raw === undefined || raw === null || raw === "") continue;
    let value: string;
    if ((key === "dueAt" || key === "startAt") && typeof raw === "string" && !Number.isNaN(Date.parse(raw))) {
      const d = new Date(raw);
      value = `${formatShortDay(d, tz, locale)}, ${formatTime(d, tz, locale)}`;
    } else if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
      value = String(raw);
    } else if (Array.isArray(raw)) {
      value = raw.filter((x) => typeof x === "string" || typeof x === "number").join(", ");
    } else continue;
    if (value.trim()) out.push({ label: t(`today.preview.${key}`), value: value.length > 300 ? `${value.slice(0, 299)}…` : value });
    if (out.length >= 6) break;
  }
  return out;
}

/** How many suggestions Today shows before "See all". */
export const TODAY_SUGGESTION_LIMIT = 3;

/* ── Activity ─────────────────────────────────────────────────────────────────────────────────────────── */

export type ActivityLike = { actor: string; subjectType: string | null; subjectId: string | null; runId: string | null; conversationId: string | null };

export const hrefsAssistant = {
  inbox: "/automations?view=inbox",
  automations: "/automations",
  run: (runId: string) => `/automations?run=${encodeURIComponent(runId)}`,
  conversation: (id: string) => `/chat/${encodeURIComponent(id)}`,
  activity: "/automations?view=activity",
};

/** Where an activity entry links: its conversation, its run, or the thing it touched. Null when there is nothing to open. */
export function activityHref(a: ActivityLike): string | null {
  if (a.conversationId) return hrefsAssistant.conversation(a.conversationId);
  if (a.runId) return hrefsAssistant.run(a.runId);
  if (a.subjectId) {
    switch (a.subjectType) {
      case "node": case "person": case "event": return `/node/${a.subjectId}`;
      case "source": return `/library/${a.subjectId}`;
      case "memory": return "/memory";
      case "automation": return hrefsAssistant.automations;
      case "suggestion": return hrefsAssistant.inbox;
      default: return null;
    }
  }
  return null;
}

export function activityActorLabel(actor: string, locale: Locale = "en"): string {
  const known = ["heartbeat", "automation", "chat", "ingest", "wiki", "keeper"];
  return todayT(locale)(`today.actor.${known.includes(actor) ? actor : "other"}`);
}

/* ── Suggested questions ──────────────────────────────────────────────────────────────────────────────── */

export type QuestionInput = {
  now: Date; tz: string;
  graphKind: string;
  /** The reader's language (English when left out). */
  locale?: Locale;
  /** The graph template's example prompts, already in the reader's language; offered when the data is quiet. */
  templatePrompts?: string[];
  children: { name: string }[];
  events: { label: string; startAt: Date; people: string[] }[];
  reminders: { title: string; dueAt: Date; about: string | null }[];
  sources: { title: string; createdAt: Date; kind?: string }[];
};

export type SuggestedQuestion = { q: string; why: string };

const OUTING = /\b(trip|tur|udflugt|zoo|museum|excursion|camp|lejrskole|outing|visit|holiday|ferie|party|fødselsdag|birthday|match|tournament|concert)\b/i;
const APPOINTMENT = /\b(dentist|tandlæge|doctor|læge|appointment|vaccination|check-?up|hospital)\b/i;
const LETTER = /\b(letter|brev|aula|school|skole|newsletter|nyhedsbrev|forældre|parents)\b/i;
const TO_SIGN = /\b(sign|slip|form|permission|pay|payment|betal|tilmeld|deadline|frist|book)\b/i;

/** "today", "tomorrow", "on Thursday", "on Tue 24 Nov" (Danish: "i dag", "i morgen", "på torsdag", "den 24. nov"). */
export function dayPhrase(date: Date, now: Date, tz: string, locale: Locale = "en", bare = false): string {
  const t = todayT(locale);
  const d = calendarDayDiff(date, now, tz);
  if (d === 0) return t("today.day.today");
  if (d === 1) return t("today.day.tomorrow");
  const vars = { day: weekdayLong(zonedParts(date, tz).weekday, locale), short: formatShortDay(date, tz, locale), dm: formatDayMonth(date, tz, locale) };
  if (d > 1 && d < 7) return t(bare ? "today.day.bareWeekday" : "today.day.onWeekday", vars);
  return t(bare ? "today.day.bareDate" : "today.day.onDate", vars);
}

/** Lower-case the first letter unless the word looks like a name or acronym ("Field trip" → "field trip", "Aula" stays). */
const PROPER = /^(Aula|SFO|MobilePay|NemID|MitID)$/;
function lowerFirst(label: string, names: string[] = []): string {
  const t = label.trim().replace(/[.?!]+$/, "");
  const first = t.split(/\s+/)[0] ?? "";
  if (first.length > 1 && first === first.toUpperCase()) return t;
  const bare = first.toLowerCase().replace(/[:,]$/, "").replace(/'s$/, "");
  if (PROPER.test(first) || names.some((n) => n.toLowerCase() === bare)) return t;
  return t.charAt(0).toLowerCase() + t.slice(1);
}

/** Strip a person's name from the start or end of a label ("Noah dentist" → "dentist"). */
function withoutName(label: string, name: string): string {
  const re = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}('s)?\\s*[:\\-–]?\\s+`, "i");
  const re2 = new RegExp(`\\s+(for\\s+)?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
  return label.replace(re, "").replace(re2, "");
}

/** "Emma's " / "Emmas ", "Mads' "; several names are joined with "and" / "og". Empty for no names. */
export function possessive(names: string[], locale: Locale = "en"): string {
  if (names.length === 0) return "";
  const one = (n: string) => (locale === "da" ? (/[sxz]$/i.test(n) ? `${n}'` : `${n}s`) : `${n}'s`);
  if (names.length === 1) return `${one(names[0])} `;
  return `${names.slice(0, -1).join(", ")} ${todayT(locale)("today.q.and")} ${one(names.at(-1)!)} `;
}

/**
 * Three or four questions worth asking right now, written from the graph's own data. In a family graph: an upcoming
 * outing, this week's letters, something to sign, a child's coming weeks. Elsewhere: what to prepare for the next
 * thing on the calendar, what is due, what was added; then the graph template's examples. Falls back to general
 * questions when the graph is empty. Deduplicated, never more than `max`.
 */
export function buildSuggestedQuestions(input: QuestionInput, max = 4): SuggestedQuestion[] {
  const { now, tz } = input;
  const locale = input.locale ?? "en";
  const t = todayT(locale);
  const family = input.graphKind === "family";
  const out: SuggestedQuestion[] = [];
  const seen = new Set<string>();
  const add = (q: string, why: string) => {
    const key = q.toLowerCase().replace(/[^a-z0-9æøå]+/g, " ").trim();
    if (!key || seen.has(key) || out.length >= max) return;
    seen.add(key);
    out.push({ q, why });
  };
  const day = (d: Date) => dayPhrase(d, now, tz, locale);

  const names = input.children.map((c) => c.name);
  const within = (days: number) => input.events
    .filter((e) => { const d = calendarDayDiff(e.startAt, now, tz); return d >= 0 && d <= days; })
    .sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
  const upcoming = within(14);
  const weekAgo = now.getTime() - 7 * 86_400_000;
  const recent = input.sources.filter((s) => s.createdAt.getTime() >= weekAgo);
  const dueSoon = input.reminders
    .filter((r) => calendarDayDiff(r.dueAt, now, tz) <= 14)
    .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());

  if (family) {
    // 1. The next outing (up to three weeks ahead, packing takes planning): what to bring.
    const outingReminder = input.reminders
      .filter((r) => { const d = calendarDayDiff(r.dueAt, now, tz); return d >= 0 && d <= 21 && OUTING.test(r.title); })
      .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())[0];
    const outing = within(21).find((e) => OUTING.test(e.label))
      ?? (outingReminder ? { label: outingReminder.title, startAt: outingReminder.dueAt, people: outingReminder.about ? [outingReminder.about] : [] } : undefined);
    if (outing) {
      const who = possessive(outing.people.slice(0, 2), locale);
      const label = lowerFirst(outing.people.length === 1 ? withoutName(outing.label, outing.people[0]) : outing.label, names);
      add(t("today.q.outing", { who, label, day: day(outing.startAt) }), t("today.q.comingUp", { label: outing.label }));
    }

    // 2. This week's letters.
    const letters = recent.filter((s) => LETTER.test(s.title.replace(/[-_]/g, " ")));
    if (letters.length) add(t("today.q.letters", { count: letters.length }), t("today.q.lettersWhy", { count: letters.length }));

    // 3. Something to sign, pay or book soon.
    const toSign = dueSoon.find((r) => TO_SIGN.test(r.title));
    if (toSign) add(t("today.q.toSign"), t("today.q.dueWhy", { title: toSign.title, day: dayPhrase(toSign.dueAt, now, tz, locale, true) }));

    // 4. An appointment.
    const appt = upcoming.find((e) => APPOINTMENT.test(e.label) && e !== outing);
    if (appt) {
      const who = possessive(appt.people.slice(0, 1), locale);
      const label = lowerFirst(appt.people.length === 1 ? withoutName(appt.label, appt.people[0]) : appt.label, names);
      add(t("today.q.appointment", { who, label, day: day(appt.startAt) }), t("today.q.onCalendar", { label: appt.label }));
    }

    // 5. A child's coming weeks (the one with the most going on first).
    const busiest = [...input.children]
      .map((c) => ({ c, n: upcoming.filter((e) => e.people.includes(c.name)).length + input.reminders.filter((r) => r.about === c.name).length }))
      .sort((a, b) => b.n - a.n);
    for (const { c } of busiest) add(t("today.q.child", { name: c.name }), t("today.q.childWhy", { whose: possessive([c.name], locale).trim() }));

    // 6. Other recent files.
    if (!letters.length && recent.length) add(t("today.q.recent"), t("today.q.recentWhy", { count: recent.length }));
  } else {
    // 1. The next thing on the calendar: what to prepare.
    const next = upcoming[0];
    if (next) add(t("today.q.prepare", { label: lowerFirst(next.label), day: day(next.startAt) }), t("today.q.comingUp", { label: next.label }));
    // 2. What is due soon.
    const due = dueSoon[0];
    if (due) add(t("today.q.due"), t("today.q.dueWhy", { title: due.title, day: dayPhrase(due.dueAt, now, tz, locale, true) }));
    // 3. What was added lately.
    if (recent.length) add(t("today.q.recent"), t("today.q.recentWhy", { count: recent.length }));
  }

  // Fallbacks for a quiet or empty graph.
  if (upcoming.length) add(t("today.q.week"), t("today.q.fromCalendar"));
  if (family) add(t("today.q.tomorrow"), t("today.q.fromCalendarTodos"));
  for (const p of input.templatePrompts ?? []) add(p, t("today.q.templateWhy"));
  add(t("today.q.overview"), t("today.q.overviewWhy"));
  return out;
}

/** Three example prompts for the first-run panel: real names and events where we have them. */
export function buildOnboardingExamples(input: QuestionInput): string[] {
  const t = todayT(input.locale ?? "en");
  const qs = buildSuggestedQuestions(input, 3).map((s) => s.q);
  // A new graph has little to ask about yet: fill up with questions that still work.
  for (const extra of [t("today.q.whoIsIn"), t("today.q.helpHere"), t("today.q.addFirst")]) {
    if (qs.length >= 3) break;
    if (!qs.includes(extra)) qs.push(extra);
  }
  return qs;
}

/** The "be specific" tip, from the graph's own data when possible. */
export function specificTip(input: QuestionInput): { before: string; after: string } {
  const { now, tz } = input;
  const locale = input.locale ?? "en";
  const t = todayT(locale);
  const family = input.graphKind === "family";
  const outingReminder = family ? input.reminders
    .filter((r) => { const d = calendarDayDiff(r.dueAt, now, tz); return d >= 0 && d <= 21 && OUTING.test(r.title); })
    .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())[0] : undefined;
  const outing = (family ? input.events.filter((e) => { const d = calendarDayDiff(e.startAt, now, tz); return d >= 0 && d <= 21 && OUTING.test(e.label); })
    .sort((a, b) => a.startAt.getTime() - b.startAt.getTime())[0] : undefined)
    ?? (outingReminder ? { label: outingReminder.title, startAt: outingReminder.dueAt, people: outingReminder.about ? [outingReminder.about] : [] } : undefined);
  const ev = outing ?? input.events
    .filter((e) => calendarDayDiff(e.startAt, now, tz) >= 0)
    .sort((a, b) => a.startAt.getTime() - b.startAt.getTime())
    .find((e) => e.people.length > 0) ?? input.events.find((e) => calendarDayDiff(e.startAt, now, tz) >= 0);
  if (ev) {
    const name = ev.people[0];
    const label = lowerFirst(name ? withoutName(ev.label, name) : ev.label, input.children.map((c) => c.name));
    const day = dayPhrase(ev.startAt, now, tz, locale);
    return family
      ? { before: t("today.tip.beforeEvent"), after: t("today.tip.eventFamily", { name: name ?? t("today.tip.theFamily"), label, day }) }
      : { before: t("today.tip.beforeEvent"), after: t("today.tip.event", { label, day }) };
  }
  const child = family ? input.children[0]?.name : undefined;
  return child
    ? { before: t("today.tip.beforeNew"), after: t("today.tip.child", { whose: possessive([child], locale).trim() }) }
    : { before: t("today.tip.beforeNew"), after: t("today.tip.files") };
}

/* ── Brief background ─────────────────────────────────────────────────────────────────────────────────── */

const clip = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/**
 * Background lines for the daily brief: how many suggestions wait for a decision (with a few titles) and what the
 * latest check-in found. Not citable; empty string when there is nothing to say.
 */
export function assistantBriefNotes(input: {
  now: Date; tz: string;
  pending: { title: string }[];
  heartbeat: { summary: string; createdAt: Date } | null;
}): string {
  const lines: string[] = [];
  if (input.pending.length) {
    const titles = input.pending.slice(0, 3).map((p) => `"${clip(p.title, 80)}"`).join(", ");
    lines.push(`Waiting for a decision on Today: ${input.pending.length} ${input.pending.length === 1 ? "suggestion" : "suggestions"} (${titles}${input.pending.length > 3 ? ", …" : ""}).`);
  }
  if (input.heartbeat) {
    const d = calendarDayDiff(input.heartbeat.createdAt, input.now, input.tz);
    if (d >= -1) {
      const when = d === 0 ? `today at ${formatTime(input.heartbeat.createdAt, input.tz)}` : "yesterday";
      lines.push(`Latest check-in (${when}): ${clip(input.heartbeat.summary, 240)}`);
    }
  }
  return lines.join("\n");
}

/** Plain "worked for 4s" / "worked for 1 min 5s" (Danish: "brugte 4 sek."). */
export function workedFor(ms: number | null | undefined, locale: Locale = "en"): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  const t = todayT(locale);
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return t("today.worked.s", { s });
  const m = Math.floor(s / 60), r = s % 60;
  return r ? t("today.worked.ms", { m, s: r }) : t("today.worked.m", { m });
}

/* ── First-run check-in ───────────────────────────────────────────────────────────────────────────────── */

/** The daily check-in that onboarding can turn on: every hour, every day, 07:00–20:00. It only proposes. */
export function defaultHeartbeat(tz: string, locale: Locale = "en") {
  return {
    name: todayT(locale)("today.heartbeat.name"),
    // The prompt is for the model, so it stays in English; it answers in the reader's language.
    prompt: "Look for what changed since the last check-in: new letters, mail and files, deadlines and events in the next few days, birthdays, overdue reminders. Only propose; never change anything."
      + (locale === "da" ? " Write in Danish." : ""),
    trigger: "heartbeat" as const,
    config: { everyMinutes: 60, days: [0, 1, 2, 3, 4, 5, 6], from: "07:00", to: "20:00", tz },
    oneShot: false,
    enabled: true,
  };
}

export const SUGGESTION_CAP_CHOICES = [3, 5, 10] as const;
