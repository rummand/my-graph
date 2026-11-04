import { checkText, ComplianceError } from "@/lib/compliance";
import { artifactText, blockAt } from "@/lib/compliance/blocks";
import { parseBody, route } from "@/lib/compliance/http";
import { checkBody } from "@/lib/compliance/schemas";
import { loadTarget, blockOfFor } from "@/lib/compliance/targets";
import { contentSchema } from "@/lib/artifacts/content";

export const dynamic = "force-dynamic";

/**
 * POST { targetType, targetId, text? | content?, title?, version? }: check a text against the corpora that apply to
 * it. A wiki page or document being edited sends its live text (the viewer must be allowed to edit it); anything else
 * is read on the server.
 */
export const POST = route(async (req, v) => {
  const body = await parseBody(req, checkBody);
  const t = await loadTarget(v, body.targetType, body.targetId);
  let text = t.text;
  let title = t.title;
  let blockOf = blockOfFor(t);
  if (body.text !== undefined || body.content !== undefined) {
    if (!t.canEdit) throw new ComplianceError(403, "Only people who may edit this can check unsaved text.");
    if (body.targetType === "wiki" && body.text !== undefined) {
      text = body.text;
      title = body.title ?? title;
    } else if (body.targetType === "artifact" && body.content !== undefined) {
      const parsed = contentSchema.safeParse(body.content);
      if (!parsed.success) throw new ComplianceError(400, "That document content can't be read.");
      const mapped = artifactText(parsed.data, body.title ?? t.title);
      text = mapped.text;
      title = body.title ?? title;
      blockOf = (o: number) => blockAt(mapped, o)?.id ?? null;
    }
  }
  const result = await checkText(v, {
    text, targetType: body.targetType, targetId: body.targetId,
    context: { ...t.context, title, version: body.version ?? t.version, sensitive: t.sensitive, corpusIds: body.corpusIds ?? null, missing: body.missing, blockOf },
  });
  return { result };
});
