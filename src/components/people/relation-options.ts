import type { MetaRelation } from "@/lib/meta/types";

/** A relation read from the subject's side: "is parent of" (out) / "is child of" (in). */
export type RelationOption = { value: string; key: string; direction: "out" | "in"; phrase: string; category: string };

export function relationOptions(relations: MetaRelation[], subjectType = "person", otherType = "person"): RelationOption[] {
  const fits = (types: string[], t: string) => types.length === 0 || types.includes(t);
  const out: RelationOption[] = [];
  for (const r of relations) {
    if (r.hidden) continue;
    if (fits(r.fromTypes, subjectType) && fits(r.toTypes, otherType)) out.push({ value: `${r.key}:out`, key: r.key, direction: "out", phrase: r.label, category: r.category });
    if (!r.symmetric && fits(r.fromTypes, otherType) && fits(r.toTypes, subjectType)) out.push({ value: `${r.key}:in`, key: r.key, direction: "in", phrase: r.inverseLabel, category: r.category });
  }
  const order = ["family", "social", "school", "care", "work", "place", "time", "document", "other"];
  return out.sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category) || a.phrase.localeCompare(b.phrase));
}

/** The relation a new person of this kind most likely has to the person they're added next to. */
export const KIND_RELATION: Record<string, string> = {
  partner: "partner_of:out", child: "parent_of:in", parent: "parent_of:out", sibling: "sibling_of:out",
  grandparent: "grandparent_of:out", aunt_uncle: "knows:out", cousin: "knows:out", in_law: "knows:out",
  close_friend: "friend_of:out", friend: "friend_of:out", childs_friend: "friend_of:out", childs_friend_parent: "knows:out",
  neighbour: "neighbour_of:out", teacher: "teacher_of:out", pedagogue: "teacher_of:out", school_leader: "knows:out",
  classmate: "friend_of:out", doctor: "treated_by:in", dentist: "treated_by:in", health_visitor: "treated_by:in",
  psychologist: "treated_by:in", babysitter: "knows:out", colleague: "works_with:out", manager: "works_with:out", other: "knows:out",
};
