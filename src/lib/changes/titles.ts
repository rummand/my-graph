/**
 * Titles of proposals in the reader's language (pure: no DB, no Next).
 *
 * A change set keeps its English `title` (search, logs, older readers) and, next to it, a `titleKey` + `titleParams`
 * so each person sees it in their own language: "From “Skolebrev.pdf”" is "Fra „Skolebrev.pdf“" for a Danish reader.
 * The proposers in the app pass English titles; `recognizeTitle` turns the ones My Graph itself writes into a key
 * when the set is stored (and, for rows stored before keys existed, when it is read). A title a person or the
 * assistant wrote freely has no key and is shown as written.
 *
 * Keys live under `stored.titles.*` (src/lib/i18n/messages/<locale>/stored.ts).
 */
import type { TFn } from "@/lib/i18n/core";

export type TitleParams = Record<string, string | number>;
export type TitleKey = { key: string; params: TitleParams };

type Pattern = { key: string; re: RegExp; params: (m: RegExpMatchArray) => TitleParams | null };

/** Every English title My Graph writes, most specific first. */
const PATTERNS: Pattern[] = [
  { key: "fromMeeting", re: /^From the meeting “([\s\S]+)”$/, params: (m) => ({ title: m[1] }) },
  { key: "addFromSource", re: /^Add ([\s\S]+), from “([\s\S]+)”$/, params: (m) => ({ what: m[1], title: m[2] }) },
  { key: "fromSource", re: /^From “([\s\S]+)”$/, params: (m) => ({ title: m[1] }) },
  { key: "fromWeb", re: /^From the web: ([\s\S]+)$/, params: (m) => ({ query: m[1] }) },
  { key: "fromMessage", re: /^From your message$/, params: () => ({}) },
  { key: "proposed", re: /^Proposed changes$/, params: () => ({}) },
  { key: "approvedSuggestion", re: /^Approved suggestion$/, params: () => ({}) },
  { key: "onProfile", re: /^On ([\s\S]+)'s profile$/, params: (m) => ({ name: m[1] }) },
  { key: "removeDates", re: /^Remove (\d+) dates? that came from ([\s\S]+)$/, params: (m) => ({ count: Number(m[1]), label: m[2] }) },
  { key: "aulaCalendarDates", re: /^(\d+) dates? from the Aula calendar$/, params: (m) => ({ count: Number(m[1]) }) },
  { key: "aulaCalendarChanges", re: /^Changes in the Aula calendar$/, params: () => ({}) },
  {
    key: "aulaPeople", re: /^((?:\d+ (?:person|people|school or daycare|schools and daycares|connections?)(?:, )?)*|People) from Aula$/,
    params: (m) => {
      const s = m[1];
      if (s === "People") return { people: 0, places: 0, connections: 0 };
      const n = (re: RegExp) => Number(s.match(re)?.[1] ?? 0);
      return { people: n(/(\d+) (?:person|people)\b/), places: n(/(\d+) (?:school or daycare|schools and daycares)/), connections: n(/(\d+) connections?/) };
    },
  },
  {
    // The calendar connectors: "2 new dates, 1 change, 1 cancellation from Family calendar" / "Calendar updates from X".
    key: "calendarUpdates", re: /^((?:\d+ (?:new dates?|changes?|cancellations?)(?:, )?)+|Calendar updates) from ([\s\S]+)$/,
    params: (m) => {
      const s = m[1];
      const n = (re: RegExp) => Number(s.match(re)?.[1] ?? 0);
      return s === "Calendar updates" ? { add: 0, update: 0, cancel: 0, label: m[2] } : { add: n(/(\d+) new dates?/), update: n(/(\d+) changes?/), cancel: n(/(\d+) cancellations?/), label: m[2] };
    },
  },
  { key: "datesFrom", re: /^(\d+) dates? from ([\s\S]+)$/, params: (m) => ({ count: Number(m[1]), label: m[2] }) },
  { key: "restOf", re: /^Rest of ([\s\S]+)$/, params: (m) => ({ title: m[1] }) },
];

/** The key for one of My Graph's own English titles, or null for a title someone wrote. */
export function recognizeTitle(title: string): TitleKey | null {
  for (const p of PATTERNS) {
    const m = title.match(p.re);
    if (!m) continue;
    const params = p.params(m);
    if (params) return { key: `stored.titles.${p.key}`, params };
  }
  return null;
}

/** Parts of a composite title, each a plural message under stored.titles.parts.* */
function parts(t: TFn, list: [string, number][]): string {
  return list.filter(([, n]) => n > 0).map(([k, n]) => t(`stored.titles.parts.${k}`, { count: n })).join(", ");
}

/**
 * The title in the reader's language. Uses the stored key when there is one, else recognises My Graph's own English
 * titles, else returns the title as written.
 */
export function localizeTitle(row: { title: string; titleKey?: string | null; titleParams?: TitleParams | null }, t: TFn, depth = 0): string {
  const k: TitleKey | null = row.titleKey ? { key: row.titleKey, params: row.titleParams ?? {} } : recognizeTitle(row.title);
  if (!k || !k.key.startsWith("stored.titles.")) return row.title;
  const p = k.params;
  const name = k.key.slice("stored.titles.".length);
  // A key this build doesn't know (written by a newer one): the English stays.
  const say = (key: string, vars: TitleParams = p) => t(key, vars, "\u0000") === "\u0000" ? null : t(key, vars);
  let out: string | null;
  if (name === "aulaPeople") {
    const list = parts(t, [["people", Number(p.people ?? 0)], ["places", Number(p.places ?? 0)], ["connections", Number(p.connections ?? 0)]]);
    out = list ? say("stored.titles.aulaPeople", { parts: list }) : say("stored.titles.aulaPeopleNone", {});
  } else if (name === "calendarUpdates") {
    const list = parts(t, [["newDates", Number(p.add ?? 0)], ["changes", Number(p.update ?? 0)], ["cancellations", Number(p.cancel ?? 0)]]);
    out = list ? say("stored.titles.calendarUpdates", { parts: list, label: String(p.label ?? "") }) : say("stored.titles.calendarUpdatesNone", { label: String(p.label ?? "") });
  } else if (name === "restOf" && depth < 3) {
    out = say(k.key, { title: localizeTitle({ title: String(p.title ?? "") }, t, depth + 1) });
  } else {
    out = say(k.key);
  }
  return out ?? row.title;
}

/** What to store with a new set: the key the caller gave, or the one recognised from its English title. */
export function titleKeyFor(title: string, given?: TitleKey | null): { titleKey: string | null; titleParams: TitleParams | null } {
  const k = given ?? recognizeTitle(title);
  return k ? { titleKey: k.key, titleParams: k.params } : { titleKey: null, titleParams: null };
}
