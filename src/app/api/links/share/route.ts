import { requireUser } from "@/lib/auth";
import { handle, json, readJson } from "@/lib/gbrain/http";
import { shareNode } from "@/lib/links";
import { shareBody } from "../schemas";

/** POST /api/links/share { nodeId, graphId, fields, visibility } — propose a copy (chosen fields only) in another graph. */
export function POST(req: Request) {
  return handle(async () => {
    const v = await requireUser();
    const body = shareBody.parse(await readJson(req));
    const res = await shareNode(v, body);
    return json(res, { status: 201 });
  });
}
