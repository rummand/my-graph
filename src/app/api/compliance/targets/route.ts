import { ComplianceError, getChoice, setChoice } from "@/lib/compliance";
import { parseBody, parseQuery, route } from "@/lib/compliance/http";
import { targetQuery, targetsPut } from "@/lib/compliance/schemas";
import { loadTarget } from "@/lib/compliance/targets";
import { canManageCorpora } from "@/lib/corpus";
import type { TargetType } from "@/lib/corpus/pure";

export const dynamic = "force-dynamic";

/** GET ?targetType&targetId: which corpora this page is checked against (its own choice, or the graph default). */
export const GET = route(async (req, v) => {
  const q = parseQuery(req, targetQuery);
  if (q.targetType === "graph") return getChoice(v, { targetType: "wiki" }, null);
  const t = await loadTarget(v, q.targetType, q.targetId);
  return { ...(await getChoice(v, { targetType: q.targetType, ...t.context }, q.targetId)), canEdit: t.canEdit };
});

/** PUT { targetType, targetId, corpusIds | null }: "Check against" for a page, or the graph's default set. */
export const PUT = route(async (req, v) => {
  const body = await parseBody(req, targetsPut);
  if (body.targetType === "graph") {
    if (!canManageCorpora(v)) throw new ComplianceError(403, "Only people who may change this graph can set its default corpora.");
    await setChoice(v, "graph", "", body.corpusIds);
    return getChoice(v, { targetType: "wiki" }, null);
  }
  const t = await loadTarget(v, body.targetType as TargetType, body.targetId);
  if (!t.canEdit) throw new ComplianceError(403, "Only people who may edit this can choose what it is checked against.");
  await setChoice(v, body.targetType, body.targetId, body.corpusIds);
  return getChoice(v, { targetType: body.targetType as TargetType, ...t.context }, body.targetId);
});
