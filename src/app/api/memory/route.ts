import { addMemory, canAddMemory, listMemories, viewMemories } from "@/lib/memory";
import { assertMemoryReader, assertMemoryWriter, createBody, listQuery } from "@/lib/memory/http";
import { GraphError } from "@/lib/graphs";
import { parseJson, route } from "@/lib/graphs/http";

export const dynamic = "force-dynamic";

/** GET ?status=&kind=&about=&q= : what the assistant remembers in my current graph that I may see. */
export const GET = route(async (req, v) => {
  assertMemoryReader(v);
  const sp = new URL(req.url).searchParams;
  const r = listQuery.safeParse(Object.fromEntries([...sp.entries()].filter(([, val]) => val !== "")));
  if (!r.success) throw new GraphError(400, r.error.issues[0]?.message ?? "Check the filters.");
  const list = await listMemories(v, { status: r.data.status, kind: r.data.kind, aboutNodeId: r.data.about, q: r.data.q });
  return { memories: await viewMemories(v, list), canAdd: canAddMemory(v) };
});

/** POST { kind, text, aboutNodeIds?, visibility? } : add a memory by hand. */
export const POST = route(async (req, v) => {
  assertMemoryWriter(v);
  const body = await parseJson(req, createBody);
  const m = await addMemory(v, { ...body, origin: "manual", createdByKind: "user" });
  if (!m) throw new GraphError(400, "That couldn't be saved. Check the text and try again.");
  const [memory] = await viewMemories(v, [m]);
  return Response.json({ memory }, { status: 201 });
});
