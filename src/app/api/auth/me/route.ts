import { route } from "@/lib/changes/http";
import { listGraphs } from "@/lib/graphs";
import { getPrefs } from "@/lib/i18n";

export const dynamic = "force-dynamic";

/**
 * GET /api/auth/me → { me } — who is signed in and the graph they're working in, for the native apps.
 * `locale` is the language the server writes in for this person (their setting, else Accept-Language).
 */
export const GET = route(async (_req, v) => {
  const [prefs, graphs] = await Promise.all([getPrefs(), listGraphs(v).catch(() => [])]);
  const g = graphs.find((x) => x.id === v.graphId);
  return Response.json({
    me: {
      id: v.id, name: v.name, email: v.email, role: v.role, personNodeId: v.personNodeId,
      locale: prefs.locale, theme: prefs.theme, timeZone: prefs.timeZone,
      graph: {
        id: v.graphId, name: v.graphName, kind: v.graphKind, role: v.graphRole,
        color: g?.color ?? null, memberCount: g?.memberCount ?? null, isFamily: g?.isFamily ?? false,
      },
    },
  }, { headers: { "cache-control": "private, no-store" } });
});
