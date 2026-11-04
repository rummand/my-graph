/**
 * People copy in the reader's language (pure: client and server). The meta model's labels are household data in
 * English; the built-in ones (and each template's) have translations in the "people" namespace keyed by their English
 * text, so a label a household renamed is shown exactly as they wrote it. Every helper falls back to the English.
 */
import type { Locale, TFn } from "@/lib/i18n/core";
import { BUILTIN_KINDS } from "@/lib/meta/builtins";
import { getTemplate, TEMPLATES } from "@/lib/templates/templates";
import type { RingDef } from "./circles";
import type { RoleParts } from "./relpath";
import type { Visibility } from "./types";

/** Message keys are dotted paths: text with a dot in it can't be a key, so it is shown as is. */
const keyable = (s: string | null | undefined): s is string => !!s && !s.includes(".");

/** "Emma's" / "Jens'" in English, "Emmas" / "Jens'" in Danish. */
export function whose(name: string, locale: Locale): string {
  const n = name.trim();
  if (locale === "da") return /[sxz]$/i.test(n) ? `${n}'` : `${n}s`;
  return /s$/i.test(n) ? `${n}'` : `${n}'s`;
}

/** A kind's name ("Teacher" → "Lærer"). */
export function kindName(t: TFn, label: string | null | undefined): string {
  if (!label) return "";
  return keyable(label) ? t(`people.kindName.${label}`, undefined, label) : label;
}

const BUILTIN_DESCRIPTIONS = new Map<string, string>([
  ...BUILTIN_KINDS.filter((k) => k.description).map((k) => [k.key, k.description!] as const),
  ...Object.values(TEMPLATES).flatMap((tp) => tp.kinds.filter((k) => k.description).map((k) => [k.key, k.description!] as const)),
]);

/** A kind's description, translated while it is still the built-in one. */
export function kindHelp(t: TFn, key: string, description: string | null | undefined): string | null {
  if (!description) return null;
  return BUILTIN_DESCRIPTIONS.get(key) === description ? t(`people.kindHelp.${key}`, undefined, description) : description;
}

/** A relation as read from one side ("child of" → "barn af"). */
export function relLabel(t: TFn, label: string): string {
  return keyable(label) ? t(`people.rel.${label}`, undefined, label) : label;
}

/** An attribute's name ("Birthday" → "Fødselsdag"). */
export function attrName(t: TFn, label: string): string {
  return keyable(label) ? t(`people.attr.${label}`, undefined, label) : label;
}

/**
 * "Your child" / "Dit barn", "Emma's teacher" / "Emmas lærer", "Works with you" / "Arbejder sammen med dig". `fallback`
 * is the English sentence the server made (used when there are no parts or no translation).
 */
export function rolePhrase(t: TFn, locale: Locale, role: RoleParts | null | undefined, fallback: string): string {
  if (!role) return fallback;
  if (role.noun && keyable(role.noun)) {
    return role.anchor === null
      ? t(`people.yourNoun.${role.noun}`, undefined, fallback)
      : t(`people.theirNoun.${role.noun}`, { whose: whose(role.anchor, locale) }, fallback);
  }
  if (!role.noun && keyable(role.verb)) {
    return role.anchor === null
      ? t(`people.verbYou.${role.verb}`, undefined, fallback)
      : t(`people.verbThem.${role.verb}`, { name: role.anchor }, fallback);
  }
  return fallback;
}

/** A circle's name in this graph ("Team", "Nære venner"), in the graph's own words. */
export function circleName(t: TFn, template: string, key: string): string {
  const tp = getTemplate(template);
  const own = tp.circles.find((c) => c.key === key)?.label;
  const fallback = own ?? t(`model.circle.${key}`, undefined, key.charAt(0).toUpperCase() + key.slice(1));
  return t(`people.circles.${tp.kind}.${key}`, undefined, fallback);
}

/** The rings with their names in the reader's language. */
export function localRings(t: TFn, template: string, rings: RingDef[]): RingDef[] {
  return rings.map((r) => ({ ...r, label: circleName(t, template, r.key) }));
}

/** "Struggling" … "Thriving" / "Har det svært" … "Rigtig godt". */
export function wellbeingWord(t: TFn, score: number | null | undefined): string {
  return score == null ? "" : t(`people.wellbeing.${score}`, undefined, String(score));
}

/** Who can see someone, in the words of this graph: parents and household in a family graph, editors elsewhere. */
export function visibilityName(t: TFn, family: boolean, v: Visibility): string {
  return t(`people.visibility.${family ? "family" : "graph"}.${v}`);
}
export function visibilityHelp(t: TFn, family: boolean, v: Visibility): string {
  return t(`people.visibilityHelp.${family ? "family" : "graph"}.${v}`);
}

/** Tags offered on a check-in are stored in English; shown in the reader's language. */
export function tagName(t: TFn, tag: string): string {
  return keyable(tag) ? t(`people.tags.${tag}`, undefined, tag) : tag;
}
