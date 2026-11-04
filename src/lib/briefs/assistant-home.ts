/**
 * The assistant's part of Today (pure, unit-tested): who may see it, where each suggestion came from, where an
 * activity entry links to, the questions we offer from the family's own data, the first-run examples, and the
 * background lines the daily brief gets about pending suggestions and the latest check-in.
 */
import type { Role } from "@/lib/graphs/pure";
import { calendarDayDiff, formatShortDay, formatTime, zonedParts } from "./dates";

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

function partOfDay(hour: number): string {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 22) return "evening";
  return "night";
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "this morning's", "last night's", "yesterday's", "Monday's", "3 Nov's" → used as "From this morning's check-in". */
function whenPossessive(at: Date, now: Date, tz: string): string {
  const diff = calendarDayDiff(at, now, tz);
  const p = zonedParts(at, tz);
  if (diff === 0) {
    const part = partOfDay(p.hour);
    return part === "night" ? (p.hour < 5 ? "last night's" : "tonight's") : `this ${part}'s`;
  }
  if (diff === -1) return "yesterday's";
  if (diff > -7) return `${WEEKDAYS[p.weekday]}'s`;
  return `the ${formatShortDay(at, tz).replace(/^\w+ /, "")}`;
}

/** Plain words for where a suggestion came from, e.g. "From this morning's check-in". */
export function suggestionOriginLabel(s: { origin: string; createdAt: Date }, now: Date, tz: string): string {
  const when = whenPossessive(s.createdAt, now, tz);
  const dated = !when.startsWith("the ");
  switch (s.origin) {
    case "heartbeat": return dated ? `From ${when} check-in` : `From the check-in on ${when.slice(4)}`;
    case "automation": return dated ? `From ${when} automation run` : `From an automation run on ${when.slice(4)}`;
    case "chat": return "From a chat with the assistant";
    case "ingest": return "From a file you added";
    default: return "From the assistant";
  }
}

export const SUGGESTION_KIND_LABEL: Record<SuggestionKindName, string> = {
  fact: "New fact",
  reminder: "New reminder",
  merge: "Possible duplicate",
  rule: "Family rule",
  memory: "Something to remember",
  wiki_edit: "Wiki change",
  nudge: "Idea",
};

/**
 * The "Always allow" label for a kind, or undefined when that kind must always be asked about.
 * Facts and merges change what the family's graph says is true, so they are never allowed without asking.
 */
export function alwaysAllowLabel(kind: string): string | undefined {
  switch (kind) {
    case "reminder": return "Always allow new reminders";
    case "memory": return "Always save things like this";
    case "rule": return "Always save family rules";
    case "wiki_edit": return "Always allow wiki changes";
    default: return undefined;
  }
}

const PREVIEW_KEYS: [string, string][] = [
  ["title", "Title"], ["text", "Text"], ["label", "Name"], ["relation", "Relation"], ["dueAt", "Due"],
  ["startAt", "When"], ["about", "About"], ["detail", "Details"], ["page", "Page"], ["keep", "Keep"], ["merge", "Merge"],
];

/**
 * The exact preview of what approving would write: the suggestion's own body when it has one, otherwise the known
 * fields of its payload as "Label: value" lines. Dates are formatted in the household zone. Never more than 6 lines.
 */
export function suggestionPreview(s: { body: string | null; payload: Record<string, unknown> }, tz: string): { label: string | null; value: string }[] {
  if (s.body?.trim()) return [{ label: null, value: s.body.trim() }];
  const out: { label: string | null; value: string }[] = [];
  for (const [key, label] of PREVIEW_KEYS) {
    const raw = s.payload?.[key];
    if (raw === undefined || raw === null || raw === "") continue;
    let value: string;
    if ((key === "dueAt" || key === "startAt") && typeof raw === "string" && !Number.isNaN(Date.parse(raw))) {
      const d = new Date(raw);
      value = `${formatShortDay(d, tz)}, ${formatTime(d, tz)}`;
    } else if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
      value = String(raw);
    } else if (Array.isArray(raw)) {
      value = raw.filter((x) => typeof x === "string" || typeof x === "number").join(", ");
    } else continue;
    if (value.trim()) out.push({ label, value: value.length > 300 ? `${value.slice(0, 299)}…` : value });
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

export function activityActorLabel(actor: string): string {
  switch (actor) {
    case "heartbeat": return "Check-in";
    case "automation": return "Automation";
    case "chat": return "In a chat";
    case "ingest": return "Reading a file";
    case "wiki": return "Wiki";
    default: return "Assistant";
  }
}

/* ── Suggested questions ──────────────────────────────────────────────────────────────────────────────── */

export type QuestionInput = {
  now: Date; tz: string;
  graphKind: string;
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

/** "today", "tomorrow", "on Thursday", "on Tue 24 Nov" */
export function dayPhrase(date: Date, now: Date, tz: string): string {
  const d = calendarDayDiff(date, now, tz);
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  if (d > 1 && d < 7) return `on ${WEEKDAYS[zonedParts(date, tz).weekday]}`;
  return `on ${formatShortDay(date, tz)}`;
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

/** Strip a child's name from the start of an event label ("Noah dentist" → "dentist"). */
function withoutName(label: string, name: string): string {
  const re = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}('s)?\\s*[:\\-–]?\\s+`, "i");
  const re2 = new RegExp(`\\s+(for\\s+)?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
  return label.replace(re, "").replace(re2, "");
}

function possessive(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return `${names[0]}'s `;
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}'s `;
}

/**
 * Three or four questions worth asking right now, written from the family's own data (an upcoming outing, this week's
 * letters, something to sign, a child's coming weeks). Falls back to general questions when the graph is empty.
 * Deduplicated, never more than `max`.
 */
export function buildSuggestedQuestions(input: QuestionInput, max = 4): SuggestedQuestion[] {
  const { now, tz } = input;
  const out: SuggestedQuestion[] = [];
  const seen = new Set<string>();
  const add = (q: string, why: string) => {
    const key = q.toLowerCase().replace(/[^a-z0-9æøå]+/g, " ").trim();
    if (!key || seen.has(key) || out.length >= max) return;
    seen.add(key);
    out.push({ q, why });
  };

  const names = input.children.map((c) => c.name);
  const within = (days: number) => input.events
    .filter((e) => { const d = calendarDayDiff(e.startAt, now, tz); return d >= 0 && d <= days; })
    .sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
  const upcoming = within(14);

  // 1. The next outing (up to three weeks ahead, packing takes planning): what to bring.
  const outingReminder = input.reminders
    .filter((r) => { const d = calendarDayDiff(r.dueAt, now, tz); return d >= 0 && d <= 21 && OUTING.test(r.title); })
    .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())[0];
  const outing = within(21).find((e) => OUTING.test(e.label))
    ?? (outingReminder ? { label: outingReminder.title, startAt: outingReminder.dueAt, people: outingReminder.about ? [outingReminder.about] : [] } : undefined);
  if (outing) {
    const who = possessive(outing.people.slice(0, 2));
    const label = lowerFirst(outing.people.length === 1 ? withoutName(outing.label, outing.people[0]) : outing.label, names);
    add(`What do we need for ${who}${label} ${dayPhrase(outing.startAt, now, tz)}?`, `${outing.label} is coming up`);
  }

  // 2. This week's letters.
  const weekAgo = now.getTime() - 7 * 86_400_000;
  const recent = input.sources.filter((s) => s.createdAt.getTime() >= weekAgo);
  const letters = recent.filter((s) => LETTER.test(s.title.replace(/[-_]/g, " ")));
  if (letters.length) add(letters.length === 1 ? "Summarise this week's school letter" : "Summarise this week's school letters", `${letters.length} new ${letters.length === 1 ? "letter" : "letters"} this week`);

  // 3. Something to sign, pay or book soon.
  const dueSoon = input.reminders
    .filter((r) => { const d = calendarDayDiff(r.dueAt, now, tz); return d <= 14; })
    .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
  const toSign = dueSoon.find((r) => TO_SIGN.test(r.title));
  if (toSign) add("What do we still need to sign, pay or book in the next two weeks?", `${toSign.title} is due ${dayPhrase(toSign.dueAt, now, tz).replace(/^on /, "")}`);

  // 4. An appointment.
  const appt = upcoming.find((e) => APPOINTMENT.test(e.label) && e !== outing);
  if (appt) {
    const who = possessive(appt.people.slice(0, 1));
    const label = lowerFirst(appt.people.length === 1 ? withoutName(appt.label, appt.people[0]) : appt.label, names);
    add(`What should we remember for ${who}${label} ${dayPhrase(appt.startAt, now, tz)}?`, `${appt.label} is on the calendar`);
  }

  // 5. A child's coming weeks (the one with the most going on first).
  const busiest = [...input.children]
    .map((c) => ({ c, n: upcoming.filter((e) => e.people.includes(c.name)).length + input.reminders.filter((r) => r.about === c.name).length }))
    .sort((a, b) => b.n - a.n);
  for (const { c } of busiest) add(`What's coming up for ${c.name} in the next two weeks?`, `${c.name}'s calendar and to-dos`);

  // 6. Other recent files.
  if (!letters.length && recent.length) add("Summarise what was added this week", `${recent.length} new ${recent.length === 1 ? "file" : "files"} this week`);

  // Fallbacks for a quiet or empty graph.
  if (upcoming.length) add("What's on this week, day by day?", "From the calendar");
  if (input.graphKind === "family") add("What do I need for tomorrow?", "From the calendar and to-dos");
  add("What's in this graph so far?", "A quick overview");
  return out;
}

/** Three example prompts for the first-run panel: real names and events where we have them. */
export function buildOnboardingExamples(input: QuestionInput): string[] {
  const qs = buildSuggestedQuestions(input, 3).map((s) => s.q);
  // A new graph has little to ask about yet: fill up with questions that still work.
  for (const extra of ["Who is in this graph so far?", "What can you help me with here?", "What should I add first?"]) {
    if (qs.length >= 3) break;
    if (!qs.includes(extra)) qs.push(extra);
  }
  return qs;
}

/** The "be specific" tip, from the family's own data when possible. */
export function specificTip(input: QuestionInput): { before: string; after: string } {
  const { now, tz } = input;
  const outingReminder = input.reminders
    .filter((r) => { const d = calendarDayDiff(r.dueAt, now, tz); return d >= 0 && d <= 21 && OUTING.test(r.title); })
    .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())[0];
  const outing = input.events.filter((e) => { const d = calendarDayDiff(e.startAt, now, tz); return d >= 0 && d <= 21 && OUTING.test(e.label); })
    .sort((a, b) => a.startAt.getTime() - b.startAt.getTime())[0]
    ?? (outingReminder ? { label: outingReminder.title, startAt: outingReminder.dueAt, people: outingReminder.about ? [outingReminder.about] : [] } : undefined);
  const ev = outing ?? input.events
    .filter((e) => calendarDayDiff(e.startAt, now, tz) >= 0)
    .sort((a, b) => a.startAt.getTime() - b.startAt.getTime())
    .find((e) => e.people.length > 0) ?? input.events.find((e) => calendarDayDiff(e.startAt, now, tz) >= 0);
  if (ev) {
    const name = ev.people[0];
    const label = lowerFirst(name ? withoutName(ev.label, name) : ev.label, input.children.map((c) => c.name));
    return {
      before: "What's happening?",
      after: `What does ${name ?? "the family"} need for the ${label} ${dayPhrase(ev.startAt, now, tz)}, and is anything still to sign?`,
    };
  }
  const child = input.children[0]?.name;
  return child
    ? { before: "Anything new?", after: `What did ${child}'s school send this week, and is there anything I need to reply to by Friday?` }
    : { before: "Anything new?", after: "What did I add this week, and is there anything in it with a date or a deadline?" };
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
    lines.push(`Waiting for the parent's decision on Today: ${input.pending.length} ${input.pending.length === 1 ? "suggestion" : "suggestions"} (${titles}${input.pending.length > 3 ? ", …" : ""}).`);
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

/** Plain "Worked for 4s" / "Worked for 1 min 5s". */
export function workedFor(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `worked for ${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  return r ? `worked for ${m} min ${r}s` : `worked for ${m} min`;
}

/* ── First-run check-in ───────────────────────────────────────────────────────────────────────────────── */

/** The daily check-in that onboarding can turn on: every hour, every day, 07:00–20:00. It only proposes. */
export function defaultHeartbeat(tz: string) {
  return {
    name: "Daily check-in",
    prompt: "Look for what changed since the last check-in: new letters and files, deadlines and events in the next few days, birthdays, overdue reminders. Only propose; never change anything.",
    trigger: "heartbeat" as const,
    config: { everyMinutes: 60, days: [0, 1, 2, 3, 4, 5, 6], from: "07:00", to: "20:00", tz },
    oneShot: false,
    enabled: true,
  };
}

export const SUGGESTION_CAP_CHOICES = [3, 5, 10] as const;
