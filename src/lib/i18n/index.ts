/**
 * CONTRACT: languages (English and Danish for now). Owned by the settings/i18n workstream; signatures fixed.
 * Server: `const t = await getT()` then `t("today.title")`. Client: `const t = useT()` (from "@/lib/i18n/client").
 * Messages live in src/lib/i18n/messages/<locale>/<namespace>.ts; keys are dotted "namespace.key", `{name}`
 * interpolates, `{ one, other }` objects are plurals picked by `vars.count`. Missing Danish falls back to English;
 * a key missing everywhere returns `fallback` (the optional third argument) or a readable form of the key.
 * Dates: `dateLocale(locale)` gives the date-fns locale; `getFormatDate()` formats in the reader's language and zone.
 */
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getViewer } from "@/lib/auth";
import {
  DEFAULT_LOCALE, LOCALE_COOKIE, THEME_COOKIE, isTheme, makeT, mergeDictionaries, resolveLocale,
  type Dictionary, type Locale, type TFn, type Theme,
} from "./core";
import { DEFAULT_TIME_ZONE, formatDate, isTimeZone, type DateStyle } from "./dates";
import { DICTIONARIES } from "./messages";

export {
  DEFAULT_LOCALE, LOCALES, LOCALE_NAMES, LOCALE_COOKIE, THEME_COOKIE, THEMES, interpolate, isLocale, isTheme, negotiate,
  resolveLocale, themeAttribute, makeT,
} from "./core";
export type { Locale, TFn, Theme, Vars, Dictionary } from "./core";
export { dateLocale, formatAgo, formatDate, isTimeZone, timeZoneChoices, DEFAULT_TIME_ZONE, type DateStyle } from "./dates";

export type Prefs = { locale: Locale; theme: Theme; timeZone: string; signedIn: boolean };

/** The reader's language, theme and time zone for this request. Signed-out pages use the cookies and the browser. */
export const getPrefs = cache(async (): Promise<Prefs> => {
  const [jar, h] = await Promise.all([cookies(), headers()]);
  let row: { locale: string; theme: string; timeZone: string } | undefined;
  const v = await getViewer().catch(() => null);
  if (v) {
    [row] = await db.select({ locale: users.locale, theme: users.theme, timeZone: users.timeZone })
      .from(users).where(eq(users.id, v.id)).limit(1).catch(() => []);
  }
  const locale = resolveLocale({ user: row?.locale, cookie: jar.get(LOCALE_COOKIE)?.value, acceptLanguage: h.get("accept-language") });
  const themeRaw = row?.theme ?? jar.get(THEME_COOKIE)?.value;
  return {
    locale,
    theme: isTheme(themeRaw) ? themeRaw : "system",
    timeZone: row && isTimeZone(row.timeZone) ? row.timeZone : DEFAULT_TIME_ZONE,
    signedIn: !!v,
  };
});

/** The current request's locale: the signed-in user's setting, else the mg_locale cookie, else Accept-Language. */
export async function getLocale(): Promise<Locale> {
  return (await getPrefs()).locale;
}

/** The messages for a locale with English filled in underneath (what the client provider receives). */
export function getDictionary(locale: Locale): Dictionary {
  return locale === DEFAULT_LOCALE ? DICTIONARIES.en : mergeDictionaries(DICTIONARIES.en, DICTIONARIES[locale]);
}

/** A translator for a given locale (emails, background jobs). */
export function tFor(locale: Locale): TFn {
  return makeT(locale, DICTIONARIES[locale], DICTIONARIES.en);
}

/** Server-side translator for the current request. */
export async function getT(): Promise<TFn> {
  return tFor(await getLocale());
}

/** `fmt(date, "dateTime")` in the reader's language and time zone. */
export async function getFormatDate(): Promise<(d: Date | string | number, style?: DateStyle) => string> {
  const { locale, timeZone } = await getPrefs();
  return (d, style = "date") => formatDate(d, style, { locale, timeZone });
}
