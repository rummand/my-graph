/**
 * Pure i18n core (no Next, no DB): locale negotiation, message lookup with English fallback, interpolation and
 * plurals. Shared by the server (`getT`), the client provider (`useT`) and the tests.
 */
export type Locale = "en" | "da";
export const LOCALES: Locale[] = ["en", "da"];
export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_COOKIE = "mg_locale";
export const THEME_COOKIE = "mg_theme";

/** What each language is called, in that language (so people find their own). */
export const LOCALE_NAMES: Record<Locale, string> = { en: "English", da: "Dansk" };
/** BCP 47 tag used for Intl formatting. */
export const INTL_TAG: Record<Locale, string> = { en: "en-GB", da: "da-DK" };

export type Theme = "system" | "light" | "dark";
export const THEMES: Theme[] = ["system", "light", "dark"];

export type Vars = Record<string, string | number>;
/** `t("today.title")`, `t("people.count", { count: 3 })`, `t("x.y", undefined, "Readable fallback")`. */
export type TFn = (key: string, vars?: Vars, fallback?: string) => string;

/** A message: a string, a plural form set, or a nested group of messages. */
export type PluralForms = { one: string; other: string; zero?: string };
export type Message = string | PluralForms | MessageTree;
export interface MessageTree { [key: string]: Message }
/** All namespaces for one locale: `{ today: {...}, shell: {...} }`. */
export type Dictionary = Record<string, MessageTree>;

export function isLocale(x: unknown): x is Locale {
  return typeof x === "string" && (LOCALES as string[]).includes(x);
}
export function isTheme(x: unknown): x is Theme {
  return typeof x === "string" && (THEMES as string[]).includes(x);
}

/**
 * The best locale for an Accept-Language header, or null when none of ours is asked for.
 * "da-DK,da;q=0.9,en;q=0.8" → "da". Quality values are honoured; q=0 means "not this one".
 */
export function negotiate(acceptLanguage: string | null | undefined): Locale | null {
  if (!acceptLanguage) return null;
  const asked = acceptLanguage.split(",").map((part, i) => {
    const [tag, ...params] = part.trim().split(";");
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    const quality = q ? Number(q.slice(2)) : 1;
    return { base: tag.trim().toLowerCase().split("-")[0], q: Number.isFinite(quality) ? quality : 0, i };
  }).filter((x) => x.base && x.q > 0).sort((a, b) => b.q - a.q || a.i - b.i);
  for (const a of asked) if (isLocale(a.base)) return a.base;
  return null;
}

/** The user's own setting wins, then the language cookie (signed-out pages), then the browser, then English. */
export function resolveLocale(input: { user?: string | null; cookie?: string | null; acceptLanguage?: string | null }): Locale {
  if (isLocale(input.user)) return input.user;
  if (isLocale(input.cookie)) return input.cookie;
  return negotiate(input.acceptLanguage) ?? DEFAULT_LOCALE;
}

/** `data-theme` for <html>: absent for "system" (the media query decides), else "light" or "dark". */
export function themeAttribute(theme: string | null | undefined): "light" | "dark" | undefined {
  return theme === "light" || theme === "dark" ? theme : undefined;
}

export function interpolate(s: string, vars?: Vars): string {
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

function isPlural(m: Message | undefined): m is PluralForms {
  return !!m && typeof m === "object" && typeof (m as PluralForms).other === "string" && typeof (m as PluralForms).one === "string";
}

/** The message at a dotted path, or undefined. */
export function lookup(dict: Dictionary | MessageTree, key: string): Message | undefined {
  let cur: Message | undefined = dict as MessageTree;
  for (const part of key.split(".")) {
    if (!cur || typeof cur !== "object" || isPlural(cur)) return undefined;
    cur = (cur as MessageTree)[part];
  }
  return cur;
}

/** "people.lastSeenAt" → "Last seen at": readable when a key has no text in any language. */
export function humanizeKey(key: string): string {
  const last = key.split(".").pop() ?? key;
  const words = last.replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().trim();
  return words ? words[0].toUpperCase() + words.slice(1) : key;
}

function render(m: Message, locale: Locale, vars?: Vars): string | undefined {
  if (typeof m === "string") return interpolate(m, vars);
  if (isPlural(m)) {
    const n = Number(vars?.count ?? vars?.n ?? 0);
    const form = n === 0 && m.zero !== undefined ? m.zero : new Intl.PluralRules(INTL_TAG[locale]).select(n) === "one" ? m.one : m.other;
    return interpolate(form, vars);
  }
  return undefined;
}

/**
 * A translator over a dictionary for `locale` with English as the fallback dictionary. Missing Danish text falls
 * back to English; a key missing everywhere returns the caller's fallback (interpolated), else a readable version of
 * the key. Raw keys are never shown.
 */
export function makeT(locale: Locale, dict: Dictionary, fallbackDict?: Dictionary): TFn {
  return (key, vars, fallback) => {
    const own = lookup(dict, key);
    const fromOwn = own !== undefined ? render(own, locale, vars) : undefined;
    if (fromOwn !== undefined) return fromOwn;
    if (fallbackDict) {
      const en = lookup(fallbackDict, key);
      const fromEn = en !== undefined ? render(en, "en", vars) : undefined;
      if (fromEn !== undefined) return fromEn;
    }
    return fallback !== undefined ? interpolate(fallback, vars) : humanizeKey(key);
  };
}

/** Deep-merge `over` onto `base` (used to ship one dictionary to the client: Danish over English). */
export function mergeDictionaries(base: Dictionary, over: Dictionary): Dictionary {
  const merge = (a: MessageTree, b: MessageTree): MessageTree => {
    const out: MessageTree = { ...a };
    for (const [k, v] of Object.entries(b)) {
      const prev = out[k];
      out[k] = prev && typeof prev === "object" && !isPlural(prev) && v && typeof v === "object" && !isPlural(v)
        ? merge(prev as MessageTree, v as MessageTree)
        : v;
    }
    return out;
  };
  return merge(base as MessageTree, over as MessageTree) as Dictionary;
}
