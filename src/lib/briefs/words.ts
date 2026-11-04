/**
 * The "today" and "onboarding" messages as a translator for pure helpers (dates, week strip, suggested questions).
 * Imports only these two namespaces, so client components that use the helpers don't ship the whole dictionary.
 * Server pages and client components use getT()/useT() for their own copy; both read the same files.
 */
import { makeT, type Dictionary, type Locale, type TFn } from "@/lib/i18n/core";
import enToday from "@/lib/i18n/messages/en/today";
import daToday from "@/lib/i18n/messages/da/today";
import enOnboarding from "@/lib/i18n/messages/en/onboarding";
import daOnboarding from "@/lib/i18n/messages/da/onboarding";

const EN: Dictionary = { today: enToday, onboarding: enOnboarding };
const DA: Dictionary = { today: daToday, onboarding: daOnboarding };

const cache = new Map<Locale, TFn>();

/** Translator for t("today.…") and t("onboarding.…") in `locale`, English underneath. */
export function todayT(locale: Locale = "en"): TFn {
  let t = cache.get(locale);
  if (!t) {
    t = locale === "da" ? makeT("da", DA, EN) : makeT("en", EN);
    cache.set(locale, t);
  }
  return t;
}
