import "server-only";
import type { Viewer } from "@/lib/auth";
import { getPrefs, getT } from "@/lib/i18n";
import type { Lx } from "./i18n";

/** The library's translator, language and zone for a server component. Family wording only in a family graph. */
export async function libraryLx(v: Pick<Viewer, "graphKind">): Promise<Lx> {
  const [t, prefs] = await Promise.all([getT(), getPrefs()]);
  return { t, locale: prefs.locale, timeZone: prefs.timeZone, family: v.graphKind === "family" };
}
