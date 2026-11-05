import { restoreRevision } from "@/lib/pages";
import { parseBody, route, slugParam } from "@/lib/pages/http";
import { restoreBody } from "../../schemas";

/** POST /api/pages/[slug]/restore — { revisionId, version } → a new revision with that version's title and text. */
export const POST = route<{ slug: string }>(async (req, v, params) => {
  const { slug } = slugParam.parse(params);
  const b = await parseBody(req, restoreBody);
  return restoreRevision(v, slug, b.revisionId, b.version);
});
