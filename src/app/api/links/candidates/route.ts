import { requireUser } from "@/lib/auth";
import { handle, json } from "@/lib/gbrain/http";
import { connectCandidates } from "@/lib/links";
import { candidatesQuery } from "../schemas";

/** GET /api/links/candidates?nodeId=&q=&graphId= — same-type nodes in my other graphs that I can read and write in. */
export function GET(req: Request) {
  return handle(async () => {
    const v = await requireUser();
    const sp = new URL(req.url).searchParams;
    const q = candidatesQuery.parse({ nodeId: sp.get("nodeId"), q: sp.get("q"), graphId: sp.get("graphId") });
    return json({ candidates: await connectCandidates(v, q) });
  });
}
