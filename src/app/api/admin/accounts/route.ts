import { z } from "zod";
import { parseParams } from "@/lib/auth/http";
import { adminHandle, requirePlatformAdminApi } from "@/lib/plans/admin";
import { listAccounts } from "@/lib/plans/admin-data";

const query = z.object({ q: z.string().max(200).optional() });

/** GET ?q= : accounts (metadata only). Platform admin only; 404 for everyone else. */
export async function GET(req: Request) {
  return adminHandle(async () => {
    await requirePlatformAdminApi(req);
    const { q } = parseParams(Object.fromEntries(new URL(req.url).searchParams), query);
    return Response.json({ accounts: await listAccounts({ q }) });
  });
}
