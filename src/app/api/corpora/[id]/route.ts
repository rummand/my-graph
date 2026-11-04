import { deleteCorpus, getCorpus, updateCorpus } from "@/lib/corpus";
import { corpusPatch } from "@/lib/corpus/schemas";
import { parseBody, route, uuid } from "@/lib/compliance/http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** GET: the corpus with its sources and rules (quotes hidden from documents the viewer can't open). */
export const GET = route<Ctx>(async (_req, v, { params }) => ({ corpus: await getCorpus(v, uuid.parse((await params).id)) }));

/** PATCH: change its details, scope, status or whether it is checked by default. */
export const PATCH = route<Ctx>(async (req, v, { params }) => {
  const id = uuid.parse((await params).id);
  await updateCorpus(v, id, await parseBody(req, corpusPatch));
  return { corpus: await getCorpus(v, id) };
});

export const DELETE = route<Ctx>(async (_req, v, { params }) => {
  await deleteCorpus(v, uuid.parse((await params).id));
  return { ok: true };
});
