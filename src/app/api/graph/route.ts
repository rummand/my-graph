import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { graph } from "@/lib/gbrain";
import { handle, json, optionalInt } from "@/lib/gbrain/http";

const query = z.object({
  center: z.preprocess((v) => (v === "" || v === null ? undefined : v), z.uuid({ message: "Not a valid id" }).optional()),
  limit: optionalInt(1, 1000),
});

/** GET /api/graph?center=&limit= — the visible graph (or a 2-step neighbourhood around `center`). */
export function GET(req: Request) {
  return handle(async () => {
    const v = await requireUser();
    const sp = new URL(req.url).searchParams;
    const q = query.parse({ center: sp.get("center"), limit: sp.get("limit") });
    return json(await graph(v, { centerId: q.center, limit: q.limit }));
  });
}
