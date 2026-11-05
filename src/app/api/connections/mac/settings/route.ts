/** GET /api/connections/mac/settings (helper token): what the helper may send now, and where it got to last time. */
import { helperRoute } from "@/lib/connectors/mac/http";
import { settingsFor } from "@/lib/connectors/mac/server";

export const dynamic = "force-dynamic";

export const GET = helperRoute(async (_req, a) => settingsFor(a));
