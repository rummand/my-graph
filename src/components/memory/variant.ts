/** Family wording only in a family graph: message keys under `.family` / `.other`. */
export type CopyVariant = "family" | "other";

export function variantOf(graphKind: string | null | undefined): CopyVariant {
  return graphKind === "family" ? "family" : "other";
}
