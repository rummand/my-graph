import type { Dictionary, Locale } from "../core";
import da from "./da";
import en from "./en";

/** All messages, by language. English is the source of truth; Danish falls back to it key by key. */
export const DICTIONARIES: Record<Locale, Dictionary> = { en, da };
