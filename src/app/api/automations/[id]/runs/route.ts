import { z } from "zod";
import { listRuns } from "@/lib/automations/automations";
import { parseId, parseQuery, route } from "@/lib/automations/http";

type Ctx = { params: Promise<{ id: string }> };
const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });

export const GET = route<Ctx>(async (req, v, { params }) => {
  const id = parseId((await params).id, "That automation");
  const { limit } = parseQuery(req, query);
  return { runs: await listRuns(v, id, limit) };
});
