import { getRun } from "@/lib/automations/automations";
import { errorJson, parseId, route } from "@/lib/automations/http";

type Ctx = { params: Promise<{ runId: string }> };

/** GET: one run (an automation's or a recipe's) with its steps, skipped items, citations and suggestions. */
export const GET = route<Ctx>(async (_req, v, { params }) => {
  const r = await getRun(v, parseId((await params).runId, "That run"));
  if (!r) return errorJson(404, "That run doesn't exist.");
  return r;
});
