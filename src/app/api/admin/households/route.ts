import { z } from "zod";
import { parseParams } from "@/lib/auth/http";
import { adminHandle, requirePlatformAdminApi } from "@/lib/plans/admin";
import { listHouseholds } from "@/lib/plans/admin-data";

const query = z.object({ q: z.string().max(200).optional() });

/** GET ?q= : households (metadata only). Platform admin only. */
export async function GET(req: Request) {
  return adminHandle(async () => {
    await requirePlatformAdminApi(req);
    const { q } = parseParams(Object.fromEntries(new URL(req.url).searchParams), query);
    return Response.json({ households: await listHouseholds({ q }) });
  });
}
