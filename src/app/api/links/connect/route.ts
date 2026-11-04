import { requireUser } from "@/lib/auth";
import { handle, json, readJson } from "@/lib/gbrain/http";
import { connectNodes } from "@/lib/links";
import { connectBody } from "../schemas";

/** POST /api/links/connect { nodeId, otherGraphId, otherNodeId, fields? } — link an existing node in another of my graphs. */
export function POST(req: Request) {
  return handle(async () => {
    const v = await requireUser();
    const body = connectBody.parse(await readJson(req));
    return json(await connectNodes(v, body), { status: 201 });
  });
}
