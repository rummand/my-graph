/**
 * What the Ask window tells the assistant about the page (pure, unit-tested): the section ("Library"), the open
 * record, what the list shows, the text the person selected, and whether the page's actions go along. The server
 * re-reads the record as the viewer and treats everything else as the person's own screen, quoted as data.
 */
import type { PageSelection, PageView } from "@/lib/assistant/page-actions";

/** The i18n key naming the section a path belongs to ("/library/…" → Library). */
const SECTIONS: [RegExp, string][] = [
  [/^\/$/, "shell.nav.today"],
  [/^\/library(\/|$)/, "shell.nav.library"],
  [/^\/(people|node)(\/|$)/, "shell.nav.people"],
  [/^\/timeline(\/|$)/, "shell.nav.timeline"],
  [/^\/artifacts(\/|$)/, "artifacts.nav"],
  [/^\/wiki(\/|$)/, "artifacts.nav"],
  [/^\/(corpora|rules)(\/|$)/, "corpus.nav"],
  [/^\/graph(\/|$)/, "shell.nav.connections"],
  [/^\/connections(\/|$)/, "connections.title"],
  [/^\/changes(\/|$)/, "changes.nav"],
  [/^\/history(\/|$)/, "history.nav"],
  [/^\/memory(\/|$)/, "shell.nav.memory"],
  [/^\/automations(\/|$)/, "shell.nav.automations"],
  [/^\/graphs(\/|$)/, "shell.nav.graphs"],
  [/^\/settings(\/|$)/, "shell.nav.settings"],
  [/^\/docs(\/|$)/, "docs.nav"],
  [/^\/clinical(\/|$)/, "clinical.nav"],
];

export function sectionKey(path: string): string | null {
  const p = path.split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  for (const [re, key] of SECTIONS) if (re.test(p)) return key;
  return null;
}

/** "Lejekontrakt v2 · Library", "Library · Money › Tax", or just "Library". */
export function lookingAt(input: { section: string | null; title?: string | null; detail?: string | null }): string | null {
  const parts = [input.title?.trim() || null, input.section, input.title ? null : input.detail?.trim() || null].filter((x): x is string => !!x);
  const uniq = parts.filter((x, i) => parts.indexOf(x) === i);
  return uniq.length ? uniq.join(" · ") : null;
}

export const MAX_SELECTION = 2000;

/** A page selection as sent: trimmed, collapsed whitespace, clipped; none when it's only whitespace or tiny. */
export function cleanSelection(text: string | null | undefined, locator?: string | null): PageSelection | null {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (t.length < 2) return null;
  const clipped = t.length > MAX_SELECTION ? `${t.slice(0, MAX_SELECTION - 1)}…` : t;
  const loc = locator?.replace(/\s+/g, " ").trim().slice(0, 200) || null;
  return { text: clipped, ...(loc ? { locator: loc } : {}) };
}

/** The view the server gets: the section name and what the list shows. */
export function viewFor(section: string | null, detail: string | null | undefined): PageView | null {
  const d = detail?.replace(/\s+/g, " ").trim().slice(0, 300) || null;
  if (!section && !d) return null;
  return { section: section?.slice(0, 60) ?? null, detail: d };
}
