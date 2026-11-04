import { z } from "zod";
import { canEditMemory, deleteMemory, getMemory, updateMemory, viewMemories } from "@/lib/memory";
import { assertMemoryWriter, updateBody } from "@/lib/memory/http";
import { GraphError } from "@/lib/graphs";
import { parseJson, parseParam, route } from "@/lib/graphs/http";
import type { Viewer } from "@/lib/auth";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

async function editable(v: Viewer, ctx: Ctx) {
  assertMemoryWriter(v);
  const id = parseParam((await ctx.params).id, z.string().uuid(), "That memory doesn't exist.");
  const m = await getMemory(v, id);
  if (!m) throw new GraphError(404, "That memory doesn't exist, or it isn't one you can see.");
  if (!canEditMemory(v, { ownerId: m.ownerId, visibility: m.visibility, graphId: v.graphId })) {
    throw new GraphError(403, m.visibility === "private" ? "Only the person who added this can change it." : "Only parents can change this.");
  }
  return m;
}

/** PATCH { text?, kind?, status?: active|paused, aboutNodeIds?, visibility? } : edit, confirm, pause or resume. */
export const PATCH = route<Ctx>(async (req, v, ctx) => {
  const m = await editable(v, ctx);
  const body = await parseJson(req, updateBody);
  if (body.visibility && body.visibility !== m.visibility && m.ownerId !== v.id) {
    throw new GraphError(403, "Only the person who added this decides who else sees it.");
  }
  const out = await updateMemory(v, m.id, body);
  if (!out) throw new GraphError(400, "That change couldn't be saved.");
  const [memory] = await viewMemories(v, [out]);
  return { memory };
});

/** DELETE : forget it. */
export const DELETE = route<Ctx>(async (_req, v, ctx) => {
  const m = await editable(v, ctx);
  if (!(await deleteMemory(v, m.id))) throw new GraphError(404, "That memory is already gone.");
  return { ok: true };
});
