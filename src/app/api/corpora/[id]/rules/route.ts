import { addRule, decideScope, getCorpus } from "@/lib/corpus";
import { decideBody, ruleBody } from "@/lib/corpus/schemas";
import { parseBody, route, uuid } from "@/lib/compliance/http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/**
 * POST { ids, action } or { scope: text | all | definitions | chapter, chapter?, action }: decide proposed rules.
 * Approved rules become nodes in the graph (a change set the person delivers by approving).
 */
export const POST = route<Ctx>(async (req, v, { params }) => {
  const id = uuid.parse((await params).id);
  const body = await parseBody(req, decideBody);
  const r = await decideScope(v, id, "ids" in body ? { scope: "ids", ids: body.ids, action: body.action } : body);
  return { ...r, corpus: await getCorpus(v, id) };
});

/** PUT { ref, text, modality, … }: a rule written in by hand (active at once). */
export const PUT = route<Ctx>(async (req, v, { params }) => {
  const id = uuid.parse((await params).id);
  await addRule(v, id, await parseBody(req, ruleBody));
  return { corpus: await getCorpus(v, id) };
});
