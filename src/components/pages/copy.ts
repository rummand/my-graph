/**
 * Page wording that depends on the kind of graph. Family words ("parents", "whole family") only in a family graph;
 * everywhere else the same visibility levels read as "owner and editors" and "everyone in this graph".
 * Pure, so server and client share it and it can be tested.
 */
import type { TFn } from "@/lib/i18n/core";
import type { Visibility } from "@/lib/pages/labels";
import type { CowriteMode } from "@/lib/pages/cowrite/prompt";

const fam = (family: boolean) => (family ? "family." : "");

/** "Only me" / "Parents" / "Whole family" in a family graph; "Only me" / "Owner and editors" / "Everyone in this graph" elsewhere. */
export function visibilityLabel(t: TFn, v: Visibility, family: boolean): string {
  return t(`pages.visibility.label.${fam(family)}${v}`);
}
export function visibilityHint(t: TFn, v: Visibility, family: boolean): string {
  return t(`pages.visibility.hint.${fam(family)}${v}`);
}
export function visibilitySentence(t: TFn, v: Visibility, family: boolean): string {
  return t(`pages.visibility.sentence.${fam(family)}${v}`);
}
/** The small note on an index row; null for pages everyone can see. */
export function visibilityBadge(t: TFn, v: Visibility, family: boolean): string | null {
  return v === "household" ? null : t(`pages.visibility.badge.${fam(family)}${v}`);
}

/** Example requests for co-writing; family examples (summer house, school) only in a family graph. */
export function cowriteExamples(t: TFn, mode: CowriteMode, family: boolean): string[] {
  const one = (k: string) => (family ? t(`pages.cowrite.examples.family.${k}`, undefined, t(`pages.cowrite.examples.${k}`)) : t(`pages.cowrite.examples.${k}`));
  return [one(`${mode}1`), one(`${mode}2`)];
}

const RANK: Record<Visibility, number> = { private: 0, parents: 1, household: 2 };

/**
 * The warning shown before keeping a draft that drew on items fewer people can see than the page's readers.
 * Same rule as `sensitivityWarning` in lib/pages/cowrite/prompt, worded for the reader's language and graph kind.
 */
export function cowriteWarning(
  t: TFn,
  sources: { visibility: Visibility; sensitive?: boolean }[],
  page: Visibility,
  opts: { cited?: boolean; family: boolean },
): string | null {
  const narrow = sources.filter((s) => RANK[s.visibility] < RANK[page] || s.sensitive);
  if (!narrow.length) return null;
  const parentsOnly = narrow.filter((s) => s.visibility === "parents").length;
  const privateOnes = narrow.filter((s) => s.visibility === "private").length;
  const flagged = narrow.filter((s) => s.sensitive && RANK[s.visibility] >= RANK[page]).length;
  const bits: string[] = [];
  if (privateOnes) bits.push(t("pages.cowrite.warning.onlyYou", { count: privateOnes }));
  if (parentsOnly && page === "household") bits.push(t(opts.family ? "pages.cowrite.warning.onlyParents" : "pages.cowrite.warning.onlyEditors", { count: parentsOnly }));
  if (flagged) bits.push(t("pages.cowrite.warning.sensitive", { count: flagged }));
  const who = page === "household"
    ? t(opts.family ? "pages.cowrite.warning.whoEveryoneFamily" : "pages.cowrite.warning.whoEveryone")
    : t(opts.family ? "pages.cowrite.warning.whoParentsFamily" : "pages.cowrite.warning.whoEditors");
  const list = bits.length ? bits.join(", ") : t("pages.cowrite.warning.narrower", { count: narrow.length });
  const items = narrow.length === 1 ? t("pages.cowrite.warning.anItem") : t("pages.cowrite.warning.items", { count: narrow.length });
  return t(opts.cited === false ? "pages.cowrite.warning.uncited" : "pages.cowrite.warning.cited", { items, list, who });
}
