import { runRecipe } from "@/lib/recipes";
import { parseId, parseJson, recipeRunBody, route } from "@/lib/automations/http";

type Ctx = { params: Promise<{ id: string }> };

/** POST { values?: { trip: "Skagen" } } -> { runId, text, citations, summary, steps, skipped, suggestionIds, status } */
export const POST = route<Ctx>(async (req, v, { params }) => {
  const id = parseId((await params).id, "That recipe");
  const { values } = await parseJson(req, recipeRunBody);
  return runRecipe(v, id, values ?? {});
}, { write: true });
