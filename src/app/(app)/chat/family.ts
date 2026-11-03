import type { Viewer } from "@/lib/auth";
import { peopleOverview } from "@/lib/people";
import { starterQuestions, type Starter } from "@/components/chat/recency";

/** Starter questions written around this family's own people. Falls back to household questions if People can't load. */
export async function familyStarters(v: Viewer): Promise<Starter[]> {
  try {
    const o = await peopleOverview(v);
    const family = o.people
      .filter((p) => !p.isViewer && (p.householdMember || p.kind === "child" || p.kind === "partner"))
      .map((p) => ({ id: p.id, name: p.label, kind: p.kind }));
    return starterQuestions(family);
  } catch {
    return starterQuestions([]);
  }
}
