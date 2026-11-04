/**
 * How the assistant and the background jobs speak (pure, unit-tested): in the reader's language, and about the graph
 * by its kind ("your work graph", "din arbejdsgraf"). Family wording ("family rule", "the family") only ever appears
 * in a family graph. Server code that has no request (automations, heartbeat, Brain Keeper) uses `tPure(locale)`
 * with the locale read from users.locale (see ./locale).
 */
import { DEFAULT_LOCALE, isLocale, makeT, type Locale, type TFn } from "@/lib/i18n/core";
import { DICTIONARIES } from "@/lib/i18n/messages";

const cache = new Map<Locale, TFn>();

/** A translator for a locale, without Next or the database (English fills in what Danish lacks). */
export function tPure(locale: Locale | string | null | undefined): TFn {
  const l: Locale = isLocale(locale) ? locale : DEFAULT_LOCALE;
  let t = cache.get(l);
  if (!t) { t = makeT(l, DICTIONARIES[l], DICTIONARIES.en); cache.set(l, t); }
  return t;
}

const KINDS = ["family", "personal", "work", "partner", "project", "shared", "other"] as const;

export type Voice = {
  locale: Locale;
  /** The graph's kind, normalised ("other" for anything unknown). */
  kind: (typeof KINDS)[number];
  /** Family wording (parents, children, family rules) belongs in this graph. */
  family: boolean;
  /** "your work graph" / "din arbejdsgraf", in the reader's language. */
  noun: string;
  /** The same in English, for prompts (the model's instructions are English). */
  nounEn: string;
  t: TFn;
};

export function voiceFor(graphKind: string | null | undefined, locale: Locale | string | null | undefined = DEFAULT_LOCALE): Voice {
  const kind = (KINDS as readonly string[]).includes(graphKind ?? "") ? (graphKind as Voice["kind"]) : graphKind == null ? "family" : "other";
  const t = tPure(locale);
  return {
    locale: isLocale(locale) ? locale : DEFAULT_LOCALE, kind, family: kind === "family",
    noun: t(`chat.graphNoun.${kind}`), nounEn: tPure("en")(`chat.graphNoun.${kind}`), t,
  };
}

/** The language's own name in English, for the prompt ("Danish"). */
export const LANGUAGE_NAME: Record<Locale, string> = { en: "English", da: "Danish" };

/** "a, b and c" / "a, b og c". */
export function joinAnd(xs: string[], t: TFn): string {
  if (xs.length <= 1) return xs[0] ?? "";
  return t("chat.steps.and", { a: xs.slice(0, -1).join(", "), b: xs[xs.length - 1] });
}
