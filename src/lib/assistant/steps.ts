/**
 * "Show its work" (pure, unit-tested): the steps the assistant took while answering, in words people recognise
 * ("Searched the library", "Read 3 documents", "Checked the timeline", "Recalled 2 family rules"), and the line
 * above each answer ("Worked for 4s, 3 steps").
 */
import type { AssistantStep } from "@/db/schema";
import type { ContextItem } from "./context";

export type RetrievalFlags = {
  library: boolean; timeline: boolean; people: boolean; reminders: boolean;
};

export const ALL_ON: RetrievalFlags = { library: true, timeline: true, people: true, reminders: true };

/** Assistant settings capabilities → what retrieval may look at (missing = on). */
export function flagsFrom(capabilities: Record<string, boolean> | undefined): RetrievalFlags {
  const c = capabilities ?? {};
  return { library: c.library !== false, timeline: c.timeline !== false, people: c.people !== false, reminders: c.reminders !== false };
}

/** The capabilities that are off, in words for the prompt and the steps. */
export function offWords(f: RetrievalFlags): string[] {
  const out: string[] = [];
  if (!f.library) out.push("the library");
  if (!f.timeline) out.push("the timeline");
  if (!f.people) out.push("People");
  if (!f.reminders) out.push("reminders");
  return out;
}

export type MemoryCounts = { rules: number; preferences: number; notes: number };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The search step: what was looked through. */
export function searchStep(flags: RetrievalFlags, hits: number): AssistantStep {
  return { kind: "search", label: flags.library ? "Searched the library and your graph" : "Searched your graph", count: hits };
}

/** Steps describing what was found and used, from the items that made it into the context. */
export function itemSteps(items: ContextItem[], flags: RetrievalFlags): AssistantStep[] {
  const out: AssistantStep[] = [];
  // Web pages have their own step ("Read 2 web pages"), so they don't count as documents here.
  const docs = new Set(items.filter((i) => i.kind === "passage" && !i.title.startsWith("Web page: ")).map((i) => (i as Extract<ContextItem, { kind: "passage" }>).sourceId));
  if (docs.size) out.push({ kind: "read", label: `Read ${plural(docs.size, "document")}`, count: docs.size });
  const people = items.filter((i) => i.kind === "node" && i.nodeType === "person").length;
  if (flags.people && people) out.push({ kind: "people", label: `Looked up ${plural(people, "person", "people")}`, count: people });
  const facts = items.filter((i) => i.kind === "fact").length;
  if (facts) out.push({ kind: "other", label: `Checked ${plural(facts, "fact")} and where they came from`, count: facts });
  if (flags.timeline) {
    const events = items.filter((i) => i.kind === "node" && i.nodeType === "event").length;
    out.push({ kind: "timeline", label: events ? `Checked the timeline (${plural(events, "event")})` : "Checked the timeline", count: events });
  }
  if (flags.reminders) {
    const reminders = items.filter((i) => i.kind === "reminder").length;
    if (reminders) out.push({ kind: "timeline", label: `Checked ${plural(reminders, "open reminder")}`, count: reminders });
  }
  return out;
}

/** "Recalled 2 family rules and 1 preference". */
export function memoryStep(c: MemoryCounts): AssistantStep | null {
  const parts: string[] = [];
  if (c.rules) parts.push(plural(c.rules, "family rule"));
  if (c.preferences) parts.push(plural(c.preferences, "preference"));
  if (c.notes) parts.push(plural(c.notes, "note"));
  if (!parts.length) return null;
  const label = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
  return { kind: "memory", label: `Recalled ${label}`, count: c.rules + c.preferences + c.notes };
}

/** Capabilities turned off in Assistant settings, in words. */
export function offStep(off: string[]): AssistantStep | null {
  if (!off.length) return null;
  return { kind: "other", label: `Skipped ${joinWords(off)} (turned off in Assistant settings)` };
}

export function joinWords(xs: string[]): string {
  return xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : xs[0] ?? "";
}

/** "4s", "under a second", "1 min 5s". */
export function durationWords(ms: number): string {
  if (!Number.isFinite(ms) || ms < 950) return "under a second";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m} min ${r}s` : `${m} min`;
}

/** The collapsed line above an answer: "Worked for 4s, 3 steps". */
export function workedLabel(ms: number | null | undefined, steps: AssistantStep[]): string {
  const n = steps.length;
  const time = typeof ms === "number" ? `Worked for ${durationWords(ms)}` : "Worked";
  return n ? `${time}, ${plural(n, "step")}` : time;
}

/**
 * The web steps: "Searched the web for “Lindevang Skole opening hours”" (with the number of results) and
 * "Read 2 web pages". Only URLs were read: just the reading step. Search unavailable: said plainly.
 */
export function webSteps(r: { query: string; results: number; pages: { via: "read" | "snippet" }[]; outcome: "ok" | "unavailable" | "blocked" | "nothing" }): AssistantStep[] {
  const out: AssistantStep[] = [];
  const q = r.query.length > 80 ? `${r.query.slice(0, 79).trimEnd()}…` : r.query;
  if (r.outcome === "unavailable") return [{ kind: "search", label: "Web search isn't available right now", count: 0 }];
  if (r.outcome === "blocked") return [{ kind: "other", label: "Couldn't read that page (only the public web can be read)", count: 0 }];
  if (q) out.push({ kind: "search", label: `Searched the web for “${q}”`, count: r.results });
  if (r.pages.length) out.push({ kind: "read", label: `Read ${plural(r.pages.length, "web page")}`, count: r.pages.length });
  return out;
}
