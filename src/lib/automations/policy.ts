/**
 * The rules the assistant's own work follows (pure, tested): who may use it, the daily cap, dedupe, what an
 * unattended run may do, which suggestions an "Always allow" may apply without asking, and the payload shapes.
 */
import { z } from "zod";
import type { GraphRole } from "@/lib/graphs/pure";
import type { SuggestionKind } from "./index";

/* ── Who may use it ──────────────────────────────────────────────────────────────────────────────────── */

type Who = { role: "owner" | "parent" | "child" | "guest"; graphRole: GraphRole };

/** Children and guests never see Automations, Recipes, Activity, Memory or the inbox. */
export function canUseAssistantTools(v: Who): boolean {
  return v.role !== "child" && v.role !== "guest";
}

/** Graph viewers may look but not create automations, recipes or check-ins. */
export function canCreateAssistantWork(v: Who): boolean {
  return canUseAssistantTools(v) && v.graphRole !== "viewer";
}

/* ── Daily cap and dedupe ────────────────────────────────────────────────────────────────────────────── */

/** Origins that count towards the daily cap: proactive ones. Chat suggestions answer a question the person asked. */
export const CAPPED_ORIGINS = new Set(["automation", "heartbeat", "ingest"]);
export const SUGGESTION_TTL_DAYS = 14;
export const MAX_DAILY_CAP = 50;

export type DedupeVerdict = "new" | "existing" | "never";

/**
 * What to do with a suggestion whose dedupeKey was seen before. Denied ones are never proposed again; a pending one
 * is reused; an approved one is not repeated; an expired one may come back.
 */
export function dedupeVerdict(previous: { status: "pending" | "approved" | "denied" | "expired" }[]): DedupeVerdict {
  if (previous.some((p) => p.status === "denied")) return "never";
  if (previous.some((p) => p.status === "pending" || p.status === "approved")) return "existing";
  return "new";
}

export function overDailyCap(origin: string, createdToday: number, cap: number): boolean {
  if (!CAPPED_ORIGINS.has(origin)) return false;
  return createdToday >= Math.max(0, Math.min(cap, MAX_DAILY_CAP));
}

/**
 * Group keys: a dedupeKey written "group#detail" replaces older pending suggestions of the same group (e.g. the
 * "due in the next two days" nudge is rewritten when the list changes instead of stacking up).
 */
export function dedupeGroup(key: string | null | undefined): string | null {
  if (!key) return null;
  const i = key.indexOf("#");
  return i > 0 ? key.slice(0, i) : null;
}

export function isStale(createdAt: Date, now: Date, ttlDays = SUGGESTION_TTL_DAYS): boolean {
  return now.getTime() - createdAt.getTime() > ttlDays * 24 * 3600_000;
}

/** Start of the local day (Europe/Copenhagen by default) as a UTC instant, for "today" in the cap. */
export function startOfLocalDay(now: Date, tz = "Europe/Copenhagen"): Date {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(now).reduce<Record<string, string>>((a, x) => ((a[x.type] = x.value), a), {});
  const minutesIntoDay = (+p.hour % 24) * 60 + +p.minute;
  return new Date(Math.floor(now.getTime() / 60000) * 60000 - minutesIntoDay * 60000);
}

/* ── Always allow ────────────────────────────────────────────────────────────────────────────────────── */

export const ACTION_KIND: Record<SuggestionKind, string> = {
  reminder: "reminder.create", fact: "fact.add", merge: "node.merge", memory: "memory.save", rule: "rule.save",
  wiki_edit: "wiki.edit", nudge: "nudge",
};

export const ACTION_LABEL: Record<string, string> = {
  "reminder.create": "Add reminders", "fact.add": "Add facts to the graph", "node.merge": "Merge duplicates",
  "memory.save": "Save memories", "rule.save": "Save rules", "wiki.edit": "Edit wiki pages",
  // The keys chat's approval cards use for the same choice.
  "fact.create": "Add facts to the graph from chat", "wiki.create": "Write wiki notes from chat",
};

/** The "Always allow …" button label for a kind, or null when the option makes no sense (nudges). */
export function alwaysLabelFor(kind: SuggestionKind): string | null {
  switch (kind) {
    case "reminder": return "Always allow new reminders";
    case "memory": return "Always save memories";
    case "rule": return "Always save rules";
    case "wiki_edit": return "Always allow wiki notes";
    case "fact": return "Always allow facts like this";
    case "merge": return "Always merge duplicates";
    default: return null;
  }
}

/**
 * Kinds a run (automation, check-in, recipe) may apply straight away when the person chose "Always allow" for them.
 * Runs read documents nobody checked, so only private reminders qualify; facts, merges, wiki edits and memories
 * always wait for a person, whatever the setting says.
 */
export const UNATTENDED_AUTO_APPLY = new Set<SuggestionKind>(["reminder"]);

/**
 * Whether a new suggestion may be applied without asking. Never when it rests on a library document or other outside
 * content (citations with a sourceId): text in a document is data, so an instruction hidden in it can't write anything.
 * A suggestion made inside a run (`fromRun`, e.g. a recipe someone pressed Run on, filed with origin "chat") follows
 * the unattended rules.
 */
export function autoApplies(
  kind: SuggestionKind, origin: string, alwaysAllow: string[], ctx: { fromRun?: boolean; citesSources?: boolean } = {},
): boolean {
  if (kind === "nudge") return false;
  if (!alwaysAllow.includes(ACTION_KIND[kind])) return false;
  if (ctx.citesSources) return false;
  if (origin === "chat" && !ctx.fromRun) return true;
  return UNATTENDED_AUTO_APPLY.has(kind);
}

/* ── Unattended policy (Scout: stricter when nobody is watching) ─────────────────────────────────────── */

export type UnattendedAction =
  | { type: "read"; label: string }
  | { type: "propose"; label: string }
  | { type: "write_fact"; label: string }
  | { type: "share"; label: string }
  | { type: "change_visibility"; label: string }
  | { type: "message"; label: string }
  | { type: "write_wiki"; label: string }
  | { type: "write_reminder"; label: string };

const SKIP_REASON: Record<Exclude<UnattendedAction["type"], "read" | "propose">, string> = {
  write_fact: "would add a fact to the graph",
  share: "would share something",
  change_visibility: "would change who can see something",
  message: "would send a message",
  write_wiki: "would edit a wiki page",
  write_reminder: "would add a reminder",
};

/**
 * Unattended runs may read and propose. Anything else is skipped and listed, so the person can see what it
 * would have done ("Skipped: add a reminder for Emma's dentist (would add a reminder). It's in your inbox instead.").
 */
export function applyUnattendedPolicy(actions: UnattendedAction[]): { allowed: UnattendedAction[]; skipped: string[] } {
  const allowed: UnattendedAction[] = [];
  const skipped: string[] = [];
  for (const a of actions) {
    if (a.type === "read" || a.type === "propose") allowed.push(a);
    else skipped.push(`${a.label} (${SKIP_REASON[a.type]})`);
  }
  return { allowed, skipped };
}

/** Unattended runs treat tentative and unknown-status events as busy when they pick a time. */
export function isBusy(e: { status?: string | null }): boolean {
  const s = (e.status ?? "").toLowerCase();
  return s !== "free" && s !== "cancelled" && s !== "canceled";
}

/** First free slot of `minutes` on a day between from–to (minutes after local midnight), avoiding busy events. */
export function firstFreeSlot(
  busy: { start: number; end: number; status?: string | null }[], minutes: number, from = 9 * 60, to = 20 * 60,
): number | null {
  const blocks = busy.filter(isBusy).sort((a, b) => a.start - b.start);
  let t = from;
  for (const b of blocks) {
    if (b.end <= t) continue;
    if (b.start - t >= minutes) return t;
    t = Math.max(t, b.end);
  }
  return to - t >= minutes ? t : null;
}

/* ── Payloads: exactly what approving writes ─────────────────────────────────────────────────────────── */

const id = z.uuid();
const vis = z.enum(["private", "parents", "household"]);
const nodeRef = z.object({ label: z.string().trim().min(1).max(200), type: z.enum(["person", "place", "event", "topic"]).default("topic") });

export const reminderPayload = z.object({
  title: z.string().trim().min(1).max(200),
  dueAt: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "dueAt must be a date"),
  detail: z.string().trim().max(2000).nullish(),
  aboutNodeId: id.nullish(),
});
export const factPayload = z.union([
  z.object({ edgeId: id }),
  z.object({
    fromId: id.optional(), toId: id.optional(), from: nodeRef.optional(), to: nodeRef.optional(),
    relation: z.string().trim().min(1).max(60).transform((r) => r.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")),
    sourceId: id.nullish(), quote: z.string().max(500).nullish(), confidence: z.number().min(0).max(1).optional(), agentId: z.string().max(120).optional(),
  }).refine((p) => (p.fromId || p.from) && (p.toId || p.to), "A fact needs both ends."),
]);
export const mergePayload = z.object({ keepId: id, dropId: id }).refine((p) => p.keepId !== p.dropId, "Can't merge something with itself.");
export const memoryPayload = z.object({
  text: z.string().trim().min(1).max(2000),
  kind: z.enum(["preference", "rule", "fact", "note"]).optional(),
  aboutNodeIds: z.array(id).max(20).optional(),
  visibility: vis.optional(),
  quote: z.string().max(500).nullish(), sourceId: id.nullish(), conversationId: id.nullish(), messageId: id.nullish(),
});
export const wikiEditPayload = z.object({
  title: z.string().trim().min(1).max(150),
  /** Plain text; paragraphs separated by blank lines. Appended to the page when `slug` exists, else a new page. */
  text: z.string().trim().min(1).max(20_000),
  slug: z.string().trim().max(200).nullish(),
  visibility: vis.optional(),
});
export const nudgePayload = z.object({ href: z.string().max(500).optional(), label: z.string().max(200).optional() }).passthrough();

export function validatePayload(kind: SuggestionKind, payload: unknown): { ok: true } | { ok: false; error: string } {
  const schema = { reminder: reminderPayload, fact: factPayload, merge: mergePayload, memory: memoryPayload, rule: memoryPayload, wiki_edit: wikiEditPayload, nudge: nudgePayload }[kind];
  const r = schema.safeParse(payload);
  return r.success ? { ok: true } : { ok: false, error: r.error.issues[0]?.message ?? "Invalid suggestion." };
}

/** Only internal links are followed from a nudge. */
export function safeInternalHref(href: unknown): string | undefined {
  return typeof href === "string" && href.startsWith("/") && !href.startsWith("//") ? href : undefined;
}

/* ── Condition prefilter ─────────────────────────────────────────────────────────────────────────────── */

const STOP = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with", "about", "any", "some", "is", "are", "be", "when", "if",
  "that", "this", "there", "new", "document", "documents", "letter", "letters", "file", "files", "upload", "uploads", "mentions",
  "mention", "mentioned", "says", "contains", "something", "anything", "someone", "from", "our", "we", "us", "my", "it", "its",
  "comes", "come", "arrives", "arrive", "page", "pages", "message", "messages", "talks", "refers", "has", "have",
]);

/** Keywords from a plain-language condition, cut to a stem so "vaccination" also finds "vaccine" and "vaccinated". */
export function conditionKeywords(check: string): string[] {
  const words = check.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").match(/[\p{L}\p{N}]+/gu) ?? [];
  const out = new Set<string>();
  for (const w of words) {
    if (w.length < 3 || STOP.has(w)) continue;
    out.add(stem(w));
  }
  return [...out].slice(0, 12);
}

const SUFFIXES = ["ations", "ation", "ments", "ment", "ings", "ing", "ions", "ion", "erne", "ene", "ed", "es", "er", "en", "s"];
export function stem(w: string): string {
  let s = w;
  if (s.length > 5) {
    for (const suf of SUFFIXES) if (s.endsWith(suf) && s.length - suf.length >= 4) { s = s.slice(0, -suf.length); break; }
  }
  return s.length > 6 ? s.slice(0, 6) : s;
}

/** Items whose text mentions any keyword. With no keywords every item passes (the model decides). */
export function prefilter<T extends { text: string }>(items: T[], keywords: string[]): T[] {
  if (!keywords.length) return items;
  return items.filter((i) => {
    const t = i.text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
    return keywords.some((k) => t.includes(k));
  });
}
