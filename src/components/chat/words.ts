/**
 * Pure wording helpers for the Ask screen (no React): they turn what the server stored in English (step labels,
 * proposal results, highlight tags) into the reader's language, and fall back to the stored text when a label
 * doesn't match a known shape. Never shows a raw key.
 */
import { makeT, type TFn } from "@/lib/i18n/core";
import enChat from "@/lib/i18n/messages/en/chat";
import type { AssistantStep } from "@/db/schema";

/** English translator over the chat namespace: the default for pure helpers and tests. */
export const EN_T: TFn = makeT("en", { chat: enChat });

/** "a", "a and b", "a, b and c" in the reader's language. */
export function joinList(xs: string[], t: TFn = EN_T): string {
  if (xs.length <= 1) return xs[0] ?? "";
  return t("chat.steps.and", { a: xs.slice(0, -1).join(", "), b: xs[xs.length - 1] });
}

/** "4s", "under a second", "1 min 5s" (Danish: "4 s", "under et sekund"). */
export function durationWords(ms: number, t: TFn = EN_T): string {
  if (!Number.isFinite(ms) || ms < 950) return t("chat.steps.underSecond");
  const s = Math.round(ms / 1000);
  if (s < 60) return t("chat.steps.seconds", { s });
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? t("chat.steps.minutesSeconds", { m, s: r }) : t("chat.steps.minutes", { m });
}

/** The collapsed line above an answer: "Worked for 4s, 3 steps". */
export function workedWords(ms: number | null | undefined, steps: AssistantStep[], t: TFn = EN_T): string {
  const time = typeof ms === "number" ? t("chat.steps.workedFor", { time: durationWords(ms, t) }) : t("chat.steps.worked");
  return steps.length ? t("chat.steps.withSteps", { time, count: steps.length }) : time;
}

const n = (s: string) => Number(s);

const OFF: Record<string, string> = { "the library": "library", "the timeline": "timeline", People: "people", reminders: "reminders" };

function splitList(s: string): string[] {
  const i = s.lastIndexOf(" and ");
  if (i < 0) return [s];
  return [...s.slice(0, i).split(", "), s.slice(i + 5)];
}

/**
 * A step label stored by the assistant ("Read 3 documents", "Recalled 2 family rules and 1 preference") in the
 * reader's language. `family` keeps "family rules" for family graphs; elsewhere they are just "rules".
 */
export function stepWords(label: string, t: TFn = EN_T, opts: { family?: boolean } = {}): string {
  const family = opts.family ?? true;
  if (label === "Searched the library and your graph") return t("chat.steps.searchedLibrary");
  if (label === "Searched your graph") return t("chat.steps.searched");
  if (label === "Checked the timeline") return t("chat.steps.timeline");
  if (label === "Searched the web") return t("chat.steps.searchedWeb");
  if (label === "Web search isn't available right now") return t("chat.steps.webUnavailable");
  if (label === "Couldn't read that page (only the public web can be read)") return t("chat.steps.webBlocked");
  if (label === "Didn't search the web (turned off for you)") return t("chat.steps.webOff");
  let m: RegExpMatchArray | null;
  if ((m = label.match(/^Searched the web for “(.+)”$/))) return t("chat.steps.searchedWebFor", { query: m[1] });
  if ((m = label.match(/^Read (\d+) documents?$/))) return t("chat.steps.readDocs", { count: n(m[1]) });
  if ((m = label.match(/^Read (\d+) web pages?$/))) return t("chat.steps.browsed", { count: n(m[1]) });
  if ((m = label.match(/^Looked up (\d+) (?:person|people)$/))) return t("chat.steps.lookedUp", { count: n(m[1]) });
  if ((m = label.match(/^Checked (\d+) facts? and where (?:it|they) came from$/))) return t("chat.steps.checkedFacts", { count: n(m[1]) });
  if ((m = label.match(/^Checked the timeline \((\d+) events?\)$/))) return t("chat.steps.timelineEvents", { count: n(m[1]) });
  if ((m = label.match(/^Checked (\d+) open reminders?$/))) return t("chat.steps.reminders", { count: n(m[1]) });
  if ((m = label.match(/^Proposed (\d+) changes? for approval$/))) return t("chat.steps.proposed", { count: n(m[1]) });
  if ((m = label.match(/^Checked against (\d+) corp(?:us|ora)$/))) return t("compliance.steps.checked", { count: n(m[1]) }, label);
  if ((m = label.match(/^Read (\d+) rules? from the corpora$/))) return t("compliance.steps.readRules", { count: n(m[1]) }, label);
  if ((m = label.match(/^Recalled (.+)$/))) {
    const parts = splitList(m[1]).map((p) => {
      const x = p.match(/^(\d+) (family rules?|rules?|preferences?|notes?)$/);
      if (!x) return null;
      const count = n(x[1]);
      const what = x[2].startsWith("family") ? (family ? "familyRules" : "rules") : x[2].startsWith("rule") ? "rules" : x[2].startsWith("pref") ? "preferences" : "notes";
      return t(`chat.steps.${what}`, { count });
    });
    if (parts.every((p): p is string => !!p)) return t("chat.steps.recalled", { what: joinList(parts, t) });
    return label;
  }
  if ((m = label.match(/^Skipped (.+) \(turned off in Assistant settings\)$/))) {
    const parts = splitList(m[1]).map((p) => (OFF[p] ? t(`chat.steps.off.${OFF[p]}`) : null));
    if (parts.every((p): p is string => !!p)) return t("chat.steps.skipped", { what: joinList(parts, t) });
    return label;
  }
  return label;
}

/** A proposal's result line stored by the server ("Remembered: …") in the reader's language. */
export function resultWords(label: string | null | undefined, t: TFn = EN_T): string {
  if (!label || label === "Saved") return t("chat.proposal.saved");
  if (label === "Kept by the Brain Keeper") return t("chat.result.keptByKeeper");
  let m: RegExpMatchArray | null;
  if ((m = label.match(/^Remembered: ([\s\S]+)$/))) return t("chat.result.remembered", { text: m[1] });
  if ((m = label.match(/^Kept, waiting for you to confirm: ([\s\S]+)$/))) return t("chat.result.keptWaiting", { text: m[1] });
  if ((m = label.match(/^Already remembered: ([\s\S]+)$/))) return t("chat.result.alreadyRemembered", { text: m[1] });
  if ((m = label.match(/^(?:Wiki page|Page) created: ([\s\S]+)$/))) return t("chat.result.wiki", { title: m[1] });
  if ((m = label.match(/^Added as a guess: ([\s\S]+)$/))) return t("chat.result.guess", { text: m[1] });
  if ((m = label.match(/^Reminder added for (.+?): ([\s\S]+)$/))) return t("chat.result.reminder", { day: m[1], title: m[2] });
  return label;
}

const TYPE_WORDS = ["person", "organization", "organisation", "project", "place", "event", "topic", "thing"];

/** A highlight tag from /api/annotate ("links to X", "new kind: X", "new person") in the reader's language. */
export function tagWords(tag: string, t: TFn = EN_T): string {
  let m: RegExpMatchArray | null;
  if ((m = tag.match(/^links to (.+)$/))) return t("chat.composer.tagLinks", { label: m[1] });
  if ((m = tag.match(/^new kind: (.+)$/))) return t("chat.composer.tagNewKind", { kind: m[1] });
  if ((m = tag.match(/^new (.+)$/))) {
    const w = m[1].toLowerCase();
    if (TYPE_WORDS.includes(w)) return t(`chat.composer.tagNewType.${w === "organisation" ? "organization" : w}`);
    return t("chat.composer.tagNew", { kind: m[1] });
  }
  return tag;
}
