import { z } from "zod";
import { countFindings, findingsFor, getChoice, lastRun } from "@/lib/compliance";
import { parseQuery, route } from "@/lib/compliance/http";
import { targetType } from "@/lib/compliance/schemas";
import { loadTarget } from "@/lib/compliance/targets";

export const dynamic = "force-dynamic";

/** GET ?targetType&targetId: what the last checks found (open notes and kept deviations), the last check, the corpora. */
export const GET = route(async (req, v) => {
  const q = parseQuery(req, z.object({ targetType, targetId: z.string().uuid() }));
  const t = await loadTarget(v, q.targetType, q.targetId);
  const [findings, run, choice] = await Promise.all([
    findingsFor(v, q.targetType, q.targetId),
    lastRun(v, q.targetType, q.targetId),
    getChoice(v, { targetType: q.targetType, ...t.context }, q.targetId),
  ]);
  const counts = countFindings(findings.map((f) => ({ status: f.status, verdict: f.verdict, severity: f.rule.severity })));
  return { findings, counts, run, effective: choice.effective, canEdit: t.canEdit };
});
