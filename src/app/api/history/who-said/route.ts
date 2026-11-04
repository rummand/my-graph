import { z } from "zod";
import { HttpError, query, route } from "@/lib/changes/http";
import { whoSaidField } from "@/lib/history/read";

const q = z.object({ nodeId: z.uuid(), field: z.string().trim().min(1).max(80).optional() });

/** GET /api/history/who-said?nodeId=&field= → { blame } — the last change to that field: who, when, proposal, evidence. */
export const GET = route(async (req, v) => {
  const { nodeId, field } = query(req, q);
  const blame = await whoSaidField(v, nodeId, field ?? null);
  if (!blame) throw new HttpError(404, "Nothing is recorded about that yet.");
  return { blame };
});
