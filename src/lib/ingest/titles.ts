/**
 * Source titles My Graph writes itself (placeholders such as Aula's "Sensitive, open in Aula"), in the reader's
 * language (pure). The English stays in `sources.title` (search, the document node); `meta.titleKey` + `meta.titleParams`
 * say how to show it. A person renaming the source drops the key (their own words are shown as written).
 * Keys live under `stored.sources.*`.
 */
import type { TFn } from "@/lib/i18n/core";

type Params = Record<string, string | number>;

/** Titles stored before keys existed, recognised by their exact English and where they came from. */
function legacyKey(title: string, meta: Record<string, unknown>): { key: string; params: Params } | null {
  const aula = (meta.aula ?? null) as { sensitive?: unknown } | null;
  if (title === "Sensitive, open in Aula" && aula?.sensitive === true) return { key: "stored.sources.aulaSensitive", params: {} };
  return null;
}

/** The key to keep in meta for a title My Graph writes (spread into a source's meta). */
export function sourceTitleKey(key: "aulaSensitive" | "aulaAccount" | "aulaAccountUnknown", params: Params = {}): { titleKey: string; titleParams: Params } {
  return { titleKey: `stored.sources.${key}`, titleParams: params };
}

export function localizeSourceTitle(row: { title: string; meta?: Record<string, unknown> | null }, t: TFn): string {
  const m = row.meta ?? {};
  const k = typeof m.titleKey === "string" && m.titleKey.startsWith("stored.sources.")
    ? { key: m.titleKey, params: (m.titleParams && typeof m.titleParams === "object" ? m.titleParams : {}) as Params }
    : legacyKey(row.title, m);
  if (!k) return row.title;
  const out = t(k.key, k.params, "\u0000");
  return out === "\u0000" ? row.title : out;
}
