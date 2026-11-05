/**
 * What a finding says (pure). Sentences are written from fixed templates in the reader's language (you.say.*), so
 * they work without mux and never stray: plain, warm, never judgmental, never medical or diagnostic, never a claim
 * about what goes on inside anyone else, and "goes together" instead of "causes". `bannedWords` is the check the
 * tests run over every template; `sentenceFor` falls back to a neutral line if a sentence ever fails it.
 */
import type { TFn } from "@/lib/i18n/core";
import { ideaMonth } from "./patterns";
import type { Finding, InsightView, Strength } from "./types";

/** Words no insight sentence may use (diagnosis, blame, cause, absolutes). Matched at word starts, any case. */
export const BANNED: Record<"en" | "da", string[]> = {
  en: [
    "diagnos", "depress", "anxiety", "anxious", "disorder", "illness", "sick", "symptom", "burnout", "burn-out", "adhd", "bipolar",
    "insomnia", "mental health", "therapy", "treatment", "patient", "clinical", "unhealthy", "abnormal", "cause", "because", "due to",
    "should", "must", "lazy", "failure", "failing", "you always", "you never", "addict", "obsess",
  ],
  da: [
    "diagnos", "depression", "deprimeret", "angst", "lidelse", "syg", "symptom", "udbrændt", "adhd", "bipolar", "søvnløs", "terapi",
    "behandling", "patient", "klinisk", "usund", "unormal", "forårsag", "fordi", "på grund af", "skyld", "burde", "doven", "fiasko",
    "du altid", "du aldrig", "afhængig", "besat",
  ],
};

/** Banned words found in a text (empty = fine). */
export function bannedWords(text: string, locale: "en" | "da"): string[] {
  const lower = text.toLowerCase();
  return BANNED[locale].filter((w) => new RegExp(`(?<![\\p{L}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "u").test(lower));
}

export function whenPhrase(f: Pick<Finding, "season" | "month">, t: TFn): string {
  if (f.month !== undefined) return t(`you.when.month.m${f.month}`);
  return f.season ? t(`you.when.season.${f.season}`) : "";
}

const fmtTimes = (x: number) => (x >= 10 ? String(Math.round(x)) : (Math.round(x * 10) / 10).toString());

/** The raw sentence for a finding (before the wording check). */
export function rawSentence(f: Finding, t: TFn): string {
  switch (f.kind) {
    case "season":
      if (f.person) return t(`you.say.season.person.${f.direction}`, { name: f.person.name, when: whenPhrase(f, t) });
      return t(`you.say.season.${f.signal}.${f.direction}`, { when: whenPhrase(f, t) });
    case "correlation": {
      const x = t(`you.more.${f.other}`);
      const y = t(`you.${f.direction === "up" ? "more" : "less"}.${f.signal}`);
      return t(f.lag ? "you.say.corr.next" : "you.say.corr.same", { x, y });
    }
    case "contrast":
      return t("you.say.contrast");
    case "drift":
      return t("you.say.drift", { name: f.person?.name ?? "", pct: Math.max(1, Math.round(f.effect * 100)) });
    case "anomaly":
      return t(`you.say.anomaly.${f.signal}.${f.direction}`, { times: fmtTimes(f.effect) });
    case "streak":
      return t(`you.say.streak.${f.signal}`, { count: f.n });
  }
}

export function sentenceFor(f: Finding, t: TFn, locale: "en" | "da"): string {
  const s = rawSentence(f, t);
  if (!bannedWords(s, locale).length) return s;
  return t("you.say.fallback", { signal: t(`you.signal.${f.signal}`).toLowerCase() });
}

export function strengthLine(f: Pick<Finding, "strength" | "span"> & { kind?: Finding["kind"] }, t: TFn): string {
  // Lately vs usual: say what it is compared with, not how firm a pattern is.
  if (f.kind === "anomaly") return t("you.strength.compared", { span: t("you.span.weeks", { count: f.span.weeks ?? 0 }) });
  if (f.kind === "drift") return t("you.strength.drift");
  const span = f.span.years ? t("you.span.years", { count: f.span.years }) : t("you.span.weeks", { count: f.span.weeks ?? 0 });
  return t(`you.strength.${f.strength as Strength}`, { span });
}

/** The quiet line under the sentence: correlation is not cause; where mood comes from. */
export function noteFor(f: Finding, t: TFn, moodNotes: boolean): string | null {
  const parts: string[] = [];
  if (f.kind === "correlation" || f.kind === "contrast") parts.push(t("you.note.correlation"));
  if (f.signal === "mood" || f.other === "mood") parts.push(t("you.note.mood", { notes: moodNotes ? t("you.note.moodNotes") : "" }));
  return parts.length ? parts.join(" ") : null;
}

/** A gentle idea the person may ask for: only for people whose contact dips (a season, or lately). */
export function ideaFor(f: Finding, t: TFn, now: Date): InsightView["idea"] {
  if (!f.person || f.direction !== "down" || (f.kind !== "season" && f.kind !== "drift")) return null;
  const month = ideaMonth(f, now);
  if (month === null) return null;
  return { text: t("you.idea.person", { name: f.person.name, month: t(`you.month.m${month}`) }), month, personId: f.person.id };
}
