/**
 * Compact text about people for the assistant and the daily brief. Only what the viewer may see.
 *
 *   - Emma (child) — Your child. Wellbeing: Low (2/5, 2 Nov 2026): "tired after school". Last in touch: 1 Nov 2026. Birthday: 5 Nov 2026 (turns 9, in 2 days). 1 open reminder.
 */
import { format } from "date-fns";
import type { Viewer } from "@/lib/auth";
import { peopleOverview } from "./data";
import { WELLBEING_WORDS } from "./circles";
import type { PersonSummary } from "./types";

const fmt = (iso: string) => format(new Date(iso), "d MMM yyyy");

export function personLine(p: PersonSummary): string {
  const parts: string[] = [];
  const head = `${p.label}${p.kindLabel ? ` (${p.kindLabel.toLowerCase()})` : ""}`;
  if (p.relation) parts.push(p.relation.label);
  const last = p.wellbeing[p.wellbeing.length - 1];
  if (last) {
    const trend = p.wellbeing.length >= 2 ? p.wellbeing[p.wellbeing.length - 2].score : null;
    const dir = trend === null ? "" : last.score > trend ? ", up" : last.score < trend ? ", down" : ", steady";
    // A note on a check-in marked sensitive stays out: this text goes to the assistant and the brief, which only
    // switch to local models for items flagged sensitive.
    const note = last.note && !last.sensitive ? `: "${last.note.slice(0, 160)}"` : "";
    parts.push(`Wellbeing: ${WELLBEING_WORDS[last.score] ?? last.score} (${last.score}/5, ${fmt(last.at)}${dir})${note}`);
  }
  if (p.lastContactAt) parts.push(`Last in touch: ${fmt(p.lastContactAt)}`);
  if (p.nextBirthday && p.nextBirthday.daysUntil <= 60) {
    const nb = p.nextBirthday;
    const when = nb.daysUntil === 0 ? "today" : nb.daysUntil === 1 ? "tomorrow" : `in ${nb.daysUntil} days`;
    parts.push(`Birthday: ${fmt(nb.date)} (${nb.turning !== null ? `turns ${nb.turning}, ` : ""}${when})`);
  }
  if (p.openReminders) parts.push(`${p.openReminders} open reminder${p.openReminders === 1 ? "" : "s"}`);
  return `- ${head}${parts.length ? ` — ${parts.join(". ")}.` : ""}`;
}

/**
 * Summary lines for the given people (in the given order). Unknown or invisible ids are skipped.
 * Pass an empty array to get the viewer's attention list plus the family circle.
 */
export async function peopleContext(viewer: Viewer, personIds: string[], opts: { now?: Date } = {}): Promise<string> {
  const o = await peopleOverview(viewer, { now: opts.now });
  const byId = new Map(o.people.map((p) => [p.id, p]));
  let chosen: PersonSummary[];
  if (personIds.length) chosen = personIds.map((id) => byId.get(id)).filter((p): p is PersonSummary => !!p);
  else {
    const ids = new Set([...o.attention.map((a) => a.personId), ...o.people.filter((p) => p.circle === "family" && !p.isViewer).map((p) => p.id)]);
    chosen = o.people.filter((p) => ids.has(p.id));
  }
  if (chosen.length === 0) return "";
  const lines = chosen.map(personLine);
  if (!personIds.length && o.attention.length) {
    const att = o.attention.slice(0, 8).map((a) =>
      a.reason === "wellbeing" ? `${a.label} seems ${WELLBEING_WORDS[a.score]?.toLowerCase() ?? "low"}` :
      a.reason === "birthday" ? `${a.label}'s birthday ${a.daysUntil === 0 ? "is today" : `in ${a.daysUntil} days`}` :
      (a.daysSince !== null ? `no contact with ${a.label} for ${a.daysSince} days` : `no contact logged with ${a.label} yet`));
    lines.push(`Needs attention: ${att.join("; ")}.`);
  }
  return lines.join("\n");
}
