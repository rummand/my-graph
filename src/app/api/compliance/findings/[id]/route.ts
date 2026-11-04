import { acceptFinding, findingTarget, findingsFor, setFindingStatus } from "@/lib/compliance";
import { parseBody, route, uuid } from "@/lib/compliance/http";
import { findingAction } from "@/lib/compliance/schemas";
import { loadTarget } from "@/lib/compliance/targets";
import type { TargetType } from "@/lib/corpus";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** POST { action: accept, reason } | { action: fixed } | { action: reopen }: decide one note. */
export const POST = route<Ctx>(async (req, v, { params }) => {
  const id = uuid.parse((await params).id);
  const body = await parseBody(req, findingAction);
  const target = await findingTarget(v, id);
  await loadTarget(v, target.targetType as TargetType, target.targetId); // may the viewer see what it is about?
  if (body.action === "accept") await acceptFinding(v, id, body.reason);
  else await setFindingStatus(v, id, body.action === "fixed" ? "fixed" : "open");
  return { findings: await findingsFor(v, target.targetType, target.targetId) };
});
