import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { listNodes, upsertNode } from "@/lib/gbrain";
import { handle, json, optionalInt, optionalString, readJson } from "@/lib/gbrain/http";
import { nodeCreateSchema, nodeTypes } from "@/lib/gbrain/schemas";

const query = z.object({
  type: z.preprocess((v) => (v === "" || v === null ? undefined : v), z.enum(nodeTypes).optional()),
  q: optionalString,
  limit: optionalInt(1, 500),
});

/** GET /api/nodes?type=&q=&limit= — visible nodes, best matches first when `q` is given. */
export function GET(req: Request) {
  return handle(async () => {
    const v = await requireUser();
    const sp = new URL(req.url).searchParams;
    const q = query.parse({ type: sp.get("type"), q: sp.get("q"), limit: sp.get("limit") });
    return json({ nodes: await listNodes(v, q) });
  });
}

/** POST /api/nodes — add a node by hand (reuses an existing one with the same name and type). */
export function POST(req: Request) {
  return handle(async () => {
    const v = await requireUser();
    const { note, ...input } = nodeCreateSchema.parse(await readJson(req));
    const res = await upsertNode(v, input, {
      activity: "manual_edit", agentType: "user", agentId: v.id, confidence: 1, note: note || "Added by hand",
    });
    return json(res, { status: res.created ? 201 : 200 });
  });
}
