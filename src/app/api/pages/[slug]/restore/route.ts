import { restoreRevision } from "@/lib/wiki";
import { parseBody, route, slugParam } from "@/lib/wiki/http";
import { restoreBody } from "../../schemas";

/** POST /api/wiki/[slug]/restore — { revisionId, version } → a new revision with that version's title and text. */
export const POST = route<{ slug: string }>(async (req, v, params) => {
  const { slug } = slugParam.parse(params);
  const b = await parseBody(req, restoreBody);
  return restoreRevision(v, slug, b.revisionId, b.version);
});
