import { listRevisions } from "@/lib/pages";
import { route, slugParam } from "@/lib/pages/http";

/** GET /api/pages/[slug]/revisions — newest first: version, title, author ("Assistant" for the assistant), time, summary. */
export const GET = route<{ slug: string }>(async (_req, v, params) => {
  const { slug } = slugParam.parse(params);
  return { revisions: await listRevisions(v, slug) };
});
