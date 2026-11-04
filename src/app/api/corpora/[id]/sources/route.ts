import { addSources, addUrl, getCorpus, removeSource } from "@/lib/corpus";
import { sourcesBody } from "@/lib/corpus/schemas";
import { parseBody, parseQuery, route, uuid } from "@/lib/compliance/http";
import { z } from "zod";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** POST { sourceIds, role } adds library documents; { url, role } reads a web page into the library and adds it. */
export const POST = route<Ctx>(async (req, v, { params }) => {
  const id = uuid.parse((await params).id);
  const body = await parseBody(req, sourcesBody);
  if ("url" in body) await addUrl(v, id, body.url, { role: body.role });
  else await addSources(v, id, body.sourceIds, { role: body.role });
  return { corpus: await getCorpus(v, id) };
});

/** DELETE ?sourceId=: take a document out of the corpus (its rules stay until someone retires them). */
export const DELETE = route<Ctx>(async (req, v, { params }) => {
  const id = uuid.parse((await params).id);
  const { sourceId } = parseQuery(req, z.object({ sourceId: uuid }));
  await removeSource(v, id, sourceId);
  return { corpus: await getCorpus(v, id) };
});
