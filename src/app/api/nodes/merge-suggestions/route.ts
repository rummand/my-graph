import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { dismissMergeSuggestion, mergeSuggestions, mergeSuggestionsFor } from "@/lib/gbrain";
import { handle, json, optionalInt, readJson } from "@/lib/gbrain/http";
import { dismissSchema } from "@/lib/gbrain/schemas";

const query = z.object({
  nodeId: z.preprocess((v) => (v === "" || v === null ? undefined : v), z.uuid({ message: "Not a valid id" }).optional()),
  limit: optionalInt(1, 100),
});

/** GET /api/nodes/merge-suggestions?nodeId=&limit= — pairs that look like the same thing. */
export function GET(req: Request) {
  return handle(async () => {
    const v = await requireUser();
    const sp = new URL(req.url).searchParams;
    const q = query.parse({ nodeId: sp.get("nodeId"), limit: sp.get("limit") });
    const suggestions = q.nodeId ? await mergeSuggestionsFor(v, q.nodeId, q.limit ?? 5) : await mergeSuggestions(v, q.limit ?? 20);
    return json({ suggestions });
  });
}

/** POST /api/nodes/merge-suggestions { aId, bId } — "these are different": stop suggesting the pair. */
export function POST(req: Request) {
  return handle(async () => {
    const v = await requireUser();
    const { aId, bId } = dismissSchema.parse(await readJson(req));
    await dismissMergeSuggestion(v, aId, bId);
    return json({ ok: true });
  });
}
