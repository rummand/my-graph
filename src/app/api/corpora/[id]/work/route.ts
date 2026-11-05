import { getCorpus } from "@/lib/corpus";
import { startWork } from "@/lib/corpus/work";
import { workBody } from "@/lib/corpus/schemas";
import { parseBody, route, uuid } from "@/lib/compliance/http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/**
 * POST { mode: recheck | full }: "Check for changes" (fetch the same pages; only what changed is read, as a proposal
 * of added, changed and removed rules) or "Read again" (fetch and read everything again).
 */
export const POST = route<Ctx>(async (req, v, { params }) => {
  const id = uuid.parse((await params).id);
  const { mode } = await parseBody(req, workBody);
  const r = await startWork(v, id, mode);
  return { ...r, corpus: await getCorpus(v, id) };
});
