import { editRule, getCorpus } from "@/lib/corpus";
import { rulePatch } from "@/lib/corpus/schemas";
import { parseBody, route, uuid } from "@/lib/compliance/http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; ruleId: string }> };

/** PATCH: edit a rule's words, reference, modality or severity, or retire / restore an active rule. */
export const PATCH = route<Ctx>(async (req, v, { params }) => {
  const p = await params;
  const id = uuid.parse(p.id);
  await editRule(v, id, uuid.parse(p.ruleId), await parseBody(req, rulePatch));
  return { corpus: await getCorpus(v, id) };
});
