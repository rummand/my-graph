import type { Viewer } from "@/lib/auth";
import type { TFn } from "@/lib/i18n";
import { peopleOverview } from "@/lib/people";
import { templateFor } from "@/lib/templates";
import { starterQuestions, templateStarters, type Starter } from "@/components/chat/recency";

/**
 * Starter questions for the current graph. A family graph gets questions written around its own people (school,
 * Aula, check-ups); every other graph gets its template's example prompts, so a Work graph never suggests Aula.
 */
export async function graphStarters(v: Viewer, t: TFn): Promise<Starter[]> {
  if (v.graphKind !== "family") return templateStarters(v.graphKind, templateFor(v).prompts, t);
  try {
    const o = await peopleOverview(v);
    const family = o.people
      .filter((p) => !p.isViewer && (p.householdMember || p.kind === "child" || p.kind === "partner"))
      .map((p) => ({ id: p.id, name: p.label, kind: p.kind }));
    return starterQuestions(family, t);
  } catch {
    return starterQuestions([], t);
  }
}
