import { createRecipe, listRecipesFor } from "@/lib/recipes";
import { parseJson, recipeCreateBody, route } from "@/lib/automations/http";

/** GET: recipes in this graph I may see (the starter set is added the first time). */
export const GET = route(async (_req, v) => ({ recipes: await listRecipesFor(v, { seed: true }) }));

/** POST { name, description?, prompt, visibility? } */
export const POST = route(async (req, v) => {
  const body = await parseJson(req, recipeCreateBody);
  return Response.json({ recipe: await createRecipe(v, body) }, { status: 201 });
}, { write: true });
