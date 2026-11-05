import { listRevisions } from "@/lib/wiki";
import { route, slugParam } from "@/lib/wiki/http";

/** GET /api/wiki/[slug]/revisions — newest first: version, title, author ("Assistant" for the assistant), time, summary. */
export const GET = route<{ slug: string }>(async (_req, v, params) => {
  const { slug } = slugParam.parse(params);
  return { revisions: await listRevisions(v, slug) };
});
