/**
 * POST /api/connections/mac/outbox/ack { id, kind: "reminder", done: true } (app token) → { id, done: true }: the
 * person ticked one of their own reminders done on their Mac. The only write the Mac makes; audited.
 */
import { ConnectionError } from "@/lib/connectors";
import { ackBody } from "@/lib/connectors/mac/app";
import { ackReminder } from "@/lib/connectors/mac/app-server";
import { helperRoute, readJson } from "@/lib/connectors/mac/http";

export const dynamic = "force-dynamic";

export const POST = helperRoute(async (req, a) => {
  const parsed = ackBody.safeParse(await readJson(req, 4096));
  if (!parsed.success) throw new ConnectionError(400, parsed.error.issues[0]?.message ?? "Send { id, kind: \"reminder\", done: true }.");
  return ackReminder(a, parsed.data.id);
});
