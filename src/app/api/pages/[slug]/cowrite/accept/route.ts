import { acceptAssistantDraft } from "@/lib/pages";
import { parseBody, route, slugParam } from "@/lib/pages/http";
import { acceptBody } from "../../../schemas";

type P = { slug: string };

/**
 * POST /api/pages/[slug]/cowrite/accept { version, content, instruction, mode, words?, sourceCount?, usedNarrower? }
 * Keeps the assistant's draft: a new revision attributed to "Assistant (asked by <you>)", logged in the assistant's
 * activity. 409 with `current` when someone else saved the page first.
 */
export const POST = route<P>(async (req, v, params) => {
  const { slug } = slugParam.parse(params);
  const b = await parseBody(req, acceptBody);
  const { page } = await acceptAssistantDraft(v, slug, b);
  return { page };
});
