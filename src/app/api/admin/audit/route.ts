import { z } from "zod";
import { parseParams } from "@/lib/auth/http";
import { adminHandle, requirePlatformAdminApi } from "@/lib/plans/admin";
import { adminAudit } from "@/lib/plans/admin-data";

const query = z.object({ limit: z.coerce.number().int().min(1).max(1000).optional() });

/** GET: every admin action, newest first. Platform admin only. */
export async function GET(req: Request) {
  return adminHandle(async () => {
    await requirePlatformAdminApi(req);
    const { limit } = parseParams(Object.fromEntries(new URL(req.url).searchParams), query);
    return Response.json({ entries: await adminAudit({ limit }) });
  });
}
