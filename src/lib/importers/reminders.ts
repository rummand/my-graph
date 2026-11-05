/**
 * Importer `reminders`: reminders the My Graph for Mac app read from Reminders (EventKit), sent as remindersPayload.
 * Pure. Open reminders with a date are proposed as reminders of the person who sent them (addReminder); finished ones
 * are left out entirely, and open ones without a date are only listed in the import's text (a reminder in My Graph
 * needs a date, and inventing one would be a guess). Reminders the person already has in My Graph are filtered out by
 * the Mac door before the batch is stored (connectors/mac/app.ts), so a reminder My Graph wrote back to the Mac is
 * never proposed again.
 */
import type { ChangeInput } from "@/lib/changes";
import { normName } from "./match";
import { packLines } from "./photos";
import { remindersPayload, type RemindersPayload } from "./schemas";
import type { ImportContext, ImportPlan, Importer } from "./types";

export const REMINDER_RULES = { maxProposals: 200 } as const;

type Reminder = RemindersPayload["reminders"][number];

const clean = (s: string | undefined | null) => (s ?? "").replace(/\s+/g, " ").trim();

const T = {
  en: {
    title: (n: number) => `Reminders from your Mac: ${n} open`,
    noDate: "no date",
    high: "high priority",
    left: (n: number) => `${n} more open reminders were left out to keep this proposal reviewable; they are still in the import's text.`,
    undated: (n: number) => `${n} open ${n === 1 ? "reminder has" : "reminders have"} no date, so ${n === 1 ? "it isn't" : "they aren't"} proposed; ${n === 1 ? "it is" : "they are"} searchable in the import.`,
  },
  da: {
    title: (n: number) => `Påmindelser fra din Mac: ${n} åbne`,
    noDate: "ingen dato",
    high: "høj prioritet",
    left: (n: number) => `${n} åbne påmindelser mere blev udeladt, så forslaget kan gennemgås; de står stadig i importens tekst.`,
    undated: (n: number) => `${n} åbne ${n === 1 ? "påmindelse har" : "påmindelser har"} ingen dato og foreslås derfor ikke; de kan søges i importen.`,
  },
};

/** The key two reminders are the same by: the title, and the day it is due. */
export function reminderKey(title: string, due: string | null | undefined): string {
  return `${normName(title)}|${due ? new Date(due).toISOString().slice(0, 10) : ""}`;
}

export function reminderLine(r: Reminder, locale: "en" | "da"): string {
  const L = T[locale];
  const due = r.due ? `${r.due.slice(0, 10)}${/T00:00(:00)?/.test(r.due) ? "" : ` ${r.due.slice(11, 16)}`}` : L.noDate;
  return [`${due}: ${clean(r.title)}`, r.priority === 1 ? `(${L.high})` : "", `[${clean(r.list)}]`, r.notes ? `: ${clean(r.notes).slice(0, 300)}` : ""].filter(Boolean).join(" ");
}

export function readReminders(data: RemindersPayload, ctx: ImportContext): ImportPlan {
  const L = T[ctx.locale];
  const seen = new Set<string>();
  const open = data.reminders.filter((r) => !r.done && clean(r.title) && !seen.has(r.id) && seen.add(r.id));
  const dated = open.filter((r) => r.due && !Number.isNaN(Date.parse(r.due))).sort((a, b) => a.due!.localeCompare(b.due!));
  const undated = open.filter((r) => !r.due || Number.isNaN(Date.parse(r.due)));

  const lineKey = (r: Reminder) => `${normName(r.list).replace(/:/g, " ") || "reminders"}:${r.id}`;
  const { segments, where } = packLines([...dated, ...undated].map((r) => ({ key: lineKey(r), text: reminderLine(r, ctx.locale) })));

  const changes: ChangeInput[] = [];
  const keys = new Set<string>();
  let left = 0;
  for (const r of dated) {
    const k = reminderKey(r.title, r.due);
    if (keys.has(k)) continue;
    if (keys.size >= REMINDER_RULES.maxProposals) { left++; continue; }
    keys.add(k);
    const w = where.get(lineKey(r));
    const detail = [clean(r.notes).slice(0, 1500), `From the list “${clean(r.list)}” in Reminders on your Mac.`].filter(Boolean).join("\n\n");
    changes.push({
      op: "addReminder", title: clean(r.title).slice(0, 200), dueAt: new Date(r.due!).toISOString(), detail,
      note: `An open reminder on your Mac (${clean(r.list)}).`,
      receipt: { sourceId: ctx.sourceId, quote: (w?.quote ?? reminderLine(r, ctx.locale)).slice(0, 300), locator: { region: w?.region ?? "reminders", range: `reminder:${r.id}` }, confidence: 1 },
    });
  }
  const warnings: string[] = [];
  if (left) warnings.push(L.left(left));
  if (undated.length) warnings.push(L.undated(undated.length));
  return {
    segments, changes, warnings, title: L.title(open.length), occurredAt: null, extract: false,
    counts: { reminders: changes.length, undated: undated.length, done: data.reminders.length - open.length },
  };
}

export const remindersImporter: Importer = {
  id: "reminders",
  label: "Reminders (Mac)",
  mime: "application/vnd.mygraph.reminders+json",
  detect: () => false,
  json: remindersPayload,
  // A reminder list is the person's own: kept private to them.
  privateOnly: true,
  read(input, ctx) {
    let data: RemindersPayload;
    try {
      data = remindersPayload.parse(JSON.parse(input.bytes.toString("utf8")));
    } catch {
      return { segments: [], changes: [], counts: {}, warnings: ["These reminders aren't in the expected shape."], extract: false };
    }
    return readReminders(data, ctx);
  },
};
