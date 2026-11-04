import { listVersions } from "@/lib/artifacts";
import { apiRoute, parseId } from "@/lib/artifacts/http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** GET: kept versions, newest first (others see only published ones). */
export const GET = apiRoute<Ctx>(async (_req, v, ctx) => ({ versions: await listVersions(v, parseId((await ctx.params).id)) }));
