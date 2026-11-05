/**
 * POST /api/connections/mac/catalog (helper token): the conversations (names and numbers, no messages) and Notes
 * folders (names, no notes) the helper can see, so the person can choose on /connections/mac. Answers with the
 * settings, as GET /settings does.
 */
import { ConnectionError } from "@/lib/connectors";
import { catalogBody } from "@/lib/connectors/mac/config";
import { helperRoute, readJson } from "@/lib/connectors/mac/http";
import { saveCatalog } from "@/lib/connectors/mac/server";

export const dynamic = "force-dynamic";

export const POST = helperRoute(async (req, a) => {
  const parsed = catalogBody.safeParse(await readJson(req, 2 * 1024 * 1024));
  if (!parsed.success) throw new ConnectionError(400, parsed.error.issues[0]?.message ?? "That list isn't in the expected shape.");
  return saveCatalog(a, parsed.data);
});
