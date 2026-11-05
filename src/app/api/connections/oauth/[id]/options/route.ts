import { z } from "zod";
import { ConnectionError } from "@/lib/connectors";
import { parseId, route } from "@/lib/connectors/http";
import { listOptions } from "@/lib/connectors/oauth/options";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const query = z.object({
  what: z.enum(["labels", "calendars", "mailFolders", "driveFolders", "dropboxFolders", "slackChannels"]),
  parent: z.string().max(1000).optional(),
});

/** GET ?what=labels|calendars|mailFolders|driveFolders|dropboxFolders|slackChannels[&parent=] → { options } for the settings pickers. */
export const GET = route<{ params: Promise<{ id: string }> }>(async (req, v, { params }) => {
  const id = parseId((await params).id);
  const u = new URL(req.url);
  const q = query.safeParse({ what: u.searchParams.get("what") ?? undefined, parent: u.searchParams.get("parent") ?? undefined });
  if (!q.success) throw new ConnectionError(400, "Say what to list.");
  return { options: await listOptions(v, id, q.data.what, q.data.parent || null) };
});
