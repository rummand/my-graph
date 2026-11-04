"use client";
/**
 * CONTRACT (client side of src/lib/i18n): `const t = useT()`. The provider is mounted in the root layout and receives
 * the request's locale, time zone and dictionary (that language with English underneath), so client components
 * translate without loading anything.
 */
import { createContext, createElement, useContext, useMemo, type ReactNode } from "react";
import { DEFAULT_LOCALE, makeT, type Dictionary, type Locale, type TFn } from "./core";
import { DEFAULT_TIME_ZONE, formatDate, type DateStyle } from "./dates";

export type { Locale, TFn } from "./core";
export { dateLocale, formatAgo, formatDate, type DateStyle } from "./dates";

type Ctx = { locale: Locale; timeZone: string; t: TFn };
const fallbackT = makeT(DEFAULT_LOCALE, {});
const I18nContext = createContext<Ctx>({ locale: DEFAULT_LOCALE, timeZone: DEFAULT_TIME_ZONE, t: fallbackT });

export function I18nProvider({ locale, timeZone, messages, children }: { locale: Locale; timeZone: string; messages: Dictionary; children: ReactNode }) {
  const value = useMemo<Ctx>(() => ({ locale, timeZone, t: makeT(locale, messages) }), [locale, timeZone, messages]);
  return createElement(I18nContext.Provider, { value }, children);
}

export function useT(): TFn {
  return useContext(I18nContext).t;
}

export function useLocale(): Locale {
  return useContext(I18nContext).locale;
}

export function useTimeZone(): string {
  return useContext(I18nContext).timeZone;
}

/** `fmt(date, "dateTime")` in the reader's language and time zone. */
export function useFormatDate(): (d: Date | string | number, style?: DateStyle) => string {
  const { locale, timeZone } = useContext(I18nContext);
  return useMemo(() => (d: Date | string | number, style: DateStyle = "date") => formatDate(d, style, { locale, timeZone }), [locale, timeZone]);
}
