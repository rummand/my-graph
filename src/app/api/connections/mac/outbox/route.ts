/**
 * GET /api/connections/mac/outbox?since=<cursor> (app token) → { items, cursor }: what the app may write on the Mac.
 * Only the person's own reminders in this graph (open, and finished in the last 30 days) when write-back for
 * reminders is on, and upcoming events (60 days) they can read here when write-back for events is on. Without
 * `since`: every live item. With it: what changed after it, deleted ones as { deleted: true }.
 */
import { appOrigin } from "@/lib/connectors/mcp/oauth-flow";
import { outbox } from "@/lib/connectors/mac/app-server";
import { helperRoute } from "@/lib/connectors/mac/http";

export const dynamic = "force-dynamic";

export const GET = helperRoute(async (req, a) => outbox(a, new URL(req.url).searchParams.get("since"), appOrigin(req)));
