/**
 * CONTRACT: languages (English and Danish for now). Owned by the settings/i18n workstream; signatures fixed.
 * Server: `const t = await getT()` then `t("today.title")`. Client: `const t = useT()` (from "@/lib/i18n/client").
 * Messages live in src/lib/i18n/messages/{en,da}.ts as nested objects; keys are dotted paths, `{name}` interpolates.
 * Until a key is translated, the English text is used. Dates: `dateLocale()` gives the date-fns locale.
 */
export type Locale = "en" | "da";
export const LOCALES: Locale[] = ["en", "da"];
export const DEFAULT_LOCALE: Locale = "en";

export type TFn = (key: string, vars?: Record<string, string | number>) => string;

/** The current request's locale: the signed-in user's setting, else the mg_locale cookie, else Accept-Language. */
export async function getLocale(): Promise<Locale> {
  return DEFAULT_LOCALE;
}

/** Server-side translator for the current request. */
export async function getT(): Promise<TFn> {
  return (key, vars) => interpolate(key, vars);
}

export function interpolate(s: string, vars?: Record<string, string | number>): string {
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}
