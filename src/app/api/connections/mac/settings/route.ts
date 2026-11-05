/**
 * /api/connections/mac/settings (helper or app token)
 *   GET  what the helper/app may send now and where it got to (the helper's fields), plus the app's source switches,
 *        write-back, chosen folder labels, the graph and the calls cursor.
 *   PUT  { sources?: { messages?, notes?, contacts?, calendar?, reminders?, photos?, files?, voiceMemos?, calls? },
 *          writeBack?: { reminders?, events? }, folders?: string[] } → the same as GET. Left-out fields stay.
 */
import { ConnectionError } from "@/lib/connectors";
import { appSettingsBody } from "@/lib/connectors/mac/app";
import { appSettingsFor, updateAppSettings } from "@/lib/connectors/mac/app-server";
import { helperRoute, readJson } from "@/lib/connectors/mac/http";

export const dynamic = "force-dynamic";

export const GET = helperRoute(async (_req, a) => appSettingsFor(a));

export const PUT = helperRoute(async (req, a) => {
  const parsed = appSettingsBody.safeParse(await readJson(req, 64 * 1024));
  if (!parsed.success) throw new ConnectionError(400, parsed.error.issues[0]?.message ?? "Some settings need fixing.");
  return updateAppSettings(a, parsed.data);
});
