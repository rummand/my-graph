/** GET /api/connections/mac/status (helper or app token) → { waiting, lastImports, graph, connection }: the menu bar badge. */
import { appStatus } from "@/lib/connectors/mac/app-server";
import { helperRoute } from "@/lib/connectors/mac/http";

export const dynamic = "force-dynamic";

export const GET = helperRoute(async (_req, a) => appStatus(a));
