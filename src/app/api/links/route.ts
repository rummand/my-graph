import { requireUser } from "@/lib/auth";
import { handle, json } from "@/lib/gbrain/http";
import { linksFor } from "@/lib/links";
import { nodeQuery } from "./schemas";

/** GET /api/links?nodeId= — the "Also in" section: copies in my other graphs I may see, and where I can share or connect. */
export function GET(req: Request) {
  return handle(async () => {
    const v = await requireUser();
    const { nodeId } = nodeQuery.parse({ nodeId: new URL(req.url).searchParams.get("nodeId") });
    return json({ alsoIn: await linksFor(v, nodeId) });
  });
}
