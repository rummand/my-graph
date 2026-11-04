import { requireUser } from "@/lib/auth";
import { handle, json, readJson } from "@/lib/gbrain/http";
import { unlinkNode } from "@/lib/links";
import { unlinkBody } from "../schemas";

/** POST /api/links/unlink { nodeId, otherNodeId? } — unlink (or withdraw a waiting share). Every copy stays a normal node. */
export function POST(req: Request) {
  return handle(async () => {
    const v = await requireUser();
    const body = unlinkBody.parse(await readJson(req));
    return json(await unlinkNode(v, body));
  });
}
