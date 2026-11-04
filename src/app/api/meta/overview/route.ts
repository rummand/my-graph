import { modelOverview } from "@/lib/meta/emergent";
import { handle } from "@/lib/meta/http";

/** GET /api/meta/overview — "How this graph sees the world": emerging, in use, quiet and the model's history. */
export const GET = handle(async (_req, v) => modelOverview(v));
