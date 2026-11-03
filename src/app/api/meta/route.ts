import { isParent } from "@/lib/auth";
import { getMetaModel } from "@/lib/meta";
import { route } from "@/lib/people/http";

/** GET /api/meta — the household's merged meta model (built-ins + overrides + additions; hidden built-ins flagged). */
export const GET = route(async (_req, v) => ({ ...(await getMetaModel(v)), canEdit: isParent(v) }));
