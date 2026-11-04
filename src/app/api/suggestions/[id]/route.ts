import { decideSuggestion } from "@/lib/automations";
import { decisionBody, parseId, parseJson, route } from "@/lib/automations/http";

type Ctx = { params: Promise<{ id: string }> };

/** POST { decision: "approve" | "always" | "deny" } -> { ok, href?, label? } */
export const POST = route<Ctx>(async (req, v, { params }) => {
  const id = parseId((await params).id, "That suggestion");
  const { decision } = await parseJson(req, decisionBody);
  return decideSuggestion(v, id, decision);
}, { write: true });
