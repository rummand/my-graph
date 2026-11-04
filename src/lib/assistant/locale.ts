/**
 * The language a person chose (users.locale), for text written outside a request: automation runs, check-ins, the
 * Brain Keeper, chat answers saved for later. Reading the row (not cookies) means a Danish owner's background run
 * writes Danish even when nobody is signed in. English when the row is missing or the value is unknown.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@/lib/i18n/core";
import { voiceFor, type Voice } from "./voice";

export async function localeOf(userId: string): Promise<Locale> {
  try {
    const [r] = await db.select({ locale: users.locale }).from(users).where(eq(users.id, userId)).limit(1);
    return isLocale(r?.locale) ? r.locale : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

/** The voice for a viewer: their language and their current graph's kind. */
export async function voiceOf(v: { id: string; graphKind?: string | null }): Promise<Voice> {
  return voiceFor(v.graphKind ?? "family", await localeOf(v.id));
}
