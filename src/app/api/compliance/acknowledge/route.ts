import { acceptAll, ComplianceError, findingsFor } from "@/lib/compliance";
import { parseBody, route } from "@/lib/compliance/http";
import { acknowledgeBody } from "@/lib/compliance/schemas";
import { loadTarget } from "@/lib/compliance/targets";

export const dynamic = "force-dynamic";

/** POST { targetType, targetId, reason, severities? }: "Publish anyway" — keep every open note, with the reason recorded. */
export const POST = route(async (req, v) => {
  const body = await parseBody(req, acknowledgeBody);
  const t = await loadTarget(v, body.targetType, body.targetId);
  if (!t.canEdit) throw new ComplianceError(403, "Only people who may edit this can accept its deviations.");
  const accepted = await acceptAll(v, body.targetType, body.targetId, body.reason, { severities: body.severities });
  return { accepted, findings: await findingsFor(v, body.targetType, body.targetId) };
});
