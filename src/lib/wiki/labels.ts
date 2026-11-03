/** Visibility names shown to people. Pure and client-safe. */
export type Visibility = "private" | "parents" | "household";

export const VISIBILITIES: Visibility[] = ["private", "parents", "household"];

export const VISIBILITY_LABEL: Record<Visibility, string> = {
  private: "Only me",
  parents: "Parents",
  household: "Whole family",
};

export const VISIBILITY_HINT: Record<Visibility, string> = {
  private: "Nobody else in the family can see this page.",
  parents: "You and the parents in the family can see and edit it. Children can't see it.",
  household: "Everyone in the family, children included. Anyone who can see it can edit it.",
};
