import { accountRoute } from "@/lib/mcp-server/account";
import { connectedApps, dbStore } from "@/lib/mcp-server";

/** GET /api/mcp/apps → { apps }: the AI apps I connected that still hold a live token. */
export const dynamic = "force-dynamic";
export const GET = accountRoute(async (_req, v) => ({ apps: await connectedApps(dbStore, v.id) }));
