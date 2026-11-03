import { NextResponse } from "next/server";
import { changeMember } from "@/lib/graphs";
import { changeMemberBody, parseJson, parseParam, route, uuid } from "@/lib/graphs/http";

type Ctx = { params: Promise<{ id: string; userId: string }> };

/** PATCH { role: "editor" | "viewer" }: owner only. */
export const PATCH = route(async (req, v, ctx: Ctx) => {
  const p = await ctx.params;
  const id = parseParam(p.id, uuid, "That graph doesn't exist, or you're not in it.");
  const userId = parseParam(p.userId, uuid, "That person isn't in this graph.");
  const body = await parseJson(req, changeMemberBody);
  await changeMember(v, id, userId, { role: body.role });
  return { ok: true };
});

/** DELETE: the owner removes someone, or a member removes themself (leaves). */
export const DELETE = route(async (_req, v, ctx: Ctx) => {
  const p = await ctx.params;
  const id = parseParam(p.id, uuid, "That graph doesn't exist, or you're not in it.");
  const userId = parseParam(p.userId, uuid, "That person isn't in this graph.");
  await changeMember(v, id, userId, { remove: true });
  // Leaving the graph you're working in: drop the cookie so the next request falls back to your default graph.
  const res = NextResponse.json({ ok: true, left: userId === v.id });
  if (userId === v.id && v.graphId === id) res.cookies.delete("mg_graph");
  return res;
});
