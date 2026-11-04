/**
 * Server-only translator for the admin console, Ultimate and its add-ons. The "admin" namespace is kept out of the
 * client dictionary (see messages/en/admin.ts), so hidden plan names never reach a browser that isn't shown them.
 * Falls through to the regular dictionaries for every other namespace.
 */
import { DICTIONARIES } from "@/lib/i18n/messages";
import { getLocale, makeT, type Locale, type TFn } from "@/lib/i18n";
import enAdmin from "@/lib/i18n/messages/en/admin";
import daAdmin from "@/lib/i18n/messages/da/admin";

const ADMIN = { en: enAdmin, da: daAdmin } as const;

export function adminTFor(locale: Locale): TFn {
  return makeT(locale, { ...DICTIONARIES[locale], admin: ADMIN[locale] }, { ...DICTIONARIES.en, admin: ADMIN.en });
}

export async function getAdminT(): Promise<TFn> {
  return adminTFor(await getLocale());
}
