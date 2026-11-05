/**
 * The "schoolwork" importer (pure): one child's week from MinUddannelse and/or Meebook, as the connector hands it over
 * (see widgets.ts SchoolworkBatch). Kept as a searchable source per child per week; the model reads the plan on for
 * dates and to-dos (extract: true); each open assignment the connector flagged becomes a proposed reminder for the
 * child, due the afternoon before, with a receipt quoting the assignment's line in the plan's text.
 *
 * Only the connector produces this format (detect never claims an upload). Children are matched, never proposed here:
 * the Aula connector proposes them. Agents propose, humans decide.
 */
import { z } from "zod";
import type { ChangeInput } from "@/lib/changes";
import type { TextSegment } from "@/lib/ingest/chunk";
import { matchPerson, normName } from "@/lib/importers/match";
import type { ImportKnown, Importer, ImportPlan } from "@/lib/importers/types";

const provider = z.enum(["minuddannelse", "meebook"]);
const batchSchema = z.object({
  format: z.literal("mygraph.schoolwork.v1"),
  child: z.string().min(1).max(160),
  week: z.string().regex(/^\d{4}-W\d{2}$/),
  weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  plans: z.array(z.object({ provider, heading: z.string().max(300).nullable(), text: z.string().max(200_000) })).max(20),
  assignments: z.array(z.object({
    key: z.string().max(200), provider, title: z.string().min(1).max(300), subject: z.string().max(300).nullable(),
    due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(), done: z.boolean(), text: z.string().max(20_000).nullable(),
    url: z.string().max(1000).nullable(), remind: z.boolean(),
  })).max(300),
});
export type SchoolworkInput = z.infer<typeof batchSchema>;

const PROVIDER_NAME = { minuddannelse: "MinUddannelse", meebook: "Meebook" } as const;

const words = {
  en: {
    title: (child: string, week: number) => `Weekly plan, week ${week}: ${child}`,
    plan: (p: string) => `Weekly plan from ${p}`,
    tasks: "Assignments and homework",
    due: (d: string) => `due ${d}`,
    done: "done",
    remind: (child: string, title: string) => `${child}: ${title}`,
    detail: (p: string, subject: string | null, due: string) => `${subject ? `${subject}, ` : ""}from ${p}, for ${due}.`,
    note: (p: string) => `An assignment in ${p}, so it isn't forgotten the evening before.`,
  },
  da: {
    title: (child: string, week: number) => `Ugeplan, uge ${week}: ${child}`,
    plan: (p: string) => `Ugeplan fra ${p}`,
    tasks: "Opgaver og lektier",
    due: (d: string) => `til ${d}`,
    done: "færdig",
    remind: (child: string, title: string) => `${child}: ${title}`,
    detail: (p: string, subject: string | null, due: string) => `${subject ? `${subject}, ` : ""}fra ${p}, til ${due}.`,
    note: (p: string) => `En opgave i ${p}, så den ikke bliver glemt aftenen før.`,
  },
};

/** The child in the graph: by full name (unique), else by first name among the graph's children (unique). */
export function matchChild(known: ImportKnown[], name: string): ImportKnown | null {
  const full = matchPerson(known, { name });
  if (full) return full;
  const first = normName(name).split(" ")[0];
  if (!first) return null;
  const kids = known.filter((k) => k.type === "person" && (k.kind === "child" || k.props.aulaChild === true || k.props.famlyChildId != null)
    && [k.label, ...k.aliases].some((l) => normName(l).split(" ")[0] === first));
  return kids.length === 1 ? kids[0] : null;
}

/** When to remind: 16:00 Copenhagen time (14:00 or 15:00 UTC) the day before; never in the past. */
export function remindAt(due: string, now: Date): string {
  const dayBefore = new Date(`${due}T00:00:00Z`).getTime() - 86_400_000;
  // Copenhagen is UTC+1 in winter and UTC+2 in summer (last Sunday of March to last Sunday of October).
  const d = new Date(dayBefore);
  const y = d.getUTCFullYear();
  const lastSunday = (m: number) => { const x = new Date(Date.UTC(y, m + 1, 0)); return x.getUTCDate() - x.getUTCDay(); };
  const summer = (d.getUTCMonth() > 2 && d.getUTCMonth() < 9) || (d.getUTCMonth() === 2 && d.getUTCDate() >= lastSunday(2)) || (d.getUTCMonth() === 9 && d.getUTCDate() < lastSunday(9));
  const at = new Date(dayBefore + (16 - (summer ? 2 : 1)) * 3_600_000);
  return (at.getTime() > now.getTime() ? at : now).toISOString();
}

export function readSchoolwork(bytes: Buffer, ctx: { known: ImportKnown[]; now: Date; locale: "en" | "da" }): ImportPlan {
  const b = batchSchema.parse(JSON.parse(bytes.toString("utf8")));
  const w = words[ctx.locale] ?? words.en;
  const weekNo = Number(b.week.slice(6));
  const segments: TextSegment[] = [];
  for (const p of b.plans) {
    if (!p.text.trim()) continue;
    segments.push({ text: `${w.plan(PROVIDER_NAME[p.provider])} (${b.child}, ${b.week})\n${p.heading ? `${p.heading}\n` : ""}\n${p.text.trim()}` });
  }
  // One line per assignment: the receipt's quote is exactly this line, so it is found in the source's text.
  const lineOf = (a: SchoolworkInput["assignments"][number]) =>
    `- ${a.subject ? `${a.subject}: ` : ""}${a.title}${a.due ? ` (${w.due(a.due)})` : ""}${a.done ? ` [${w.done}]` : ""}`;
  if (b.assignments.length) {
    segments.push({
      text: [`${w.tasks} (${b.child}, ${b.week})`, ...b.assignments.map((a) => `${lineOf(a)}${a.text && a.text !== a.title ? `\n  ${a.text.replace(/\s+/g, " ").slice(0, 1500)}` : ""}`)].join("\n"),
    });
  }
  const child = matchChild(ctx.known, b.child);
  const changes: ChangeInput[] = [];
  for (const a of b.assignments) {
    if (!a.remind || a.done || !a.due) continue;
    if (a.due < ctx.now.toISOString().slice(0, 10)) continue;
    const p = PROVIDER_NAME[a.provider];
    changes.push({
      op: "addReminder", title: w.remind(b.child.split(/\s+/)[0], a.title).slice(0, 200), dueAt: remindAt(a.due, ctx.now), aboutNodeId: child?.id ?? null,
      detail: w.detail(p, a.subject, a.due), note: w.note(p),
      receipt: { quote: lineOf(a), locator: { schoolwork: { provider: a.provider, assignment: a.key, week: b.week } }, confidence: 1, ...(a.url ? { url: a.url } : {}) },
    });
  }
  return {
    segments: segments.length ? segments : [{ text: `${w.title(b.child, weekNo)}` }],
    changes,
    counts: { reminders: changes.length, assignments: b.assignments.length, plans: b.plans.length },
    title: w.title(b.child, weekNo),
    occurredAt: new Date(`${b.weekStart}T06:00:00Z`),
    extract: b.plans.some((p) => p.text.trim().length > 0),
    warnings: child ? [] : [`${b.child} isn't in the graph yet (or the name matches more than one person), so the reminders aren't tied to anyone.`],
  };
}

export const schoolworkImporter: Importer = {
  id: "schoolwork",
  label: "Weekly plans and homework (MinUddannelse, Meebook)",
  mime: "application/vnd.mygraph.schoolwork+json",
  // Only the MinUddannelse connector makes this; an upload is never claimed.
  detect: () => false,
  graphKinds: ["family"],
  read: (input, ctx) => readSchoolwork(input.bytes, ctx),
};
