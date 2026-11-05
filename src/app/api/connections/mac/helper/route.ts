/** GET /api/connections/mac/helper: the My Graph for Mac helper script, with this My Graph's address and my language in it. */
import { requireUserApi } from "@/lib/auth";
import { HELPER_FILENAME, helperSource } from "@/lib/connectors/mac/helper/script";
import { appOrigin } from "@/lib/connectors/mcp/oauth-flow";
import { getLocale } from "@/lib/i18n";

export async function GET(req: Request) {
  try {
    await requireUserApi();
  } catch (e) {
    if (e instanceof Response) return e;
    return Response.json({ error: "Sign in first." }, { status: 401 });
  }
  const locale = await getLocale().catch(() => "en");
  const body = helperSource(appOrigin(req), locale === "da" ? "da" : "en");
  return new Response(body, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "content-disposition": `attachment; filename="${HELPER_FILENAME}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
