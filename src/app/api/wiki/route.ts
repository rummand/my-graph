import { NextResponse } from "next/server";
import { createPage, listPages } from "@/lib/wiki";
import { parseBody, parseQuery, route } from "@/lib/wiki/http";
import { createBody, listQuery } from "./schemas";

/** GET /api/wiki?q=&limit= — pages the viewer can see, most recently edited first (or best title match first). */
export const GET = route(async (req, v) => {
  const q = parseQuery(req, listQuery);
  return { pages: await listPages(v, q) };
});

/** POST /api/wiki — create a page: { title, visibility?, content? }. */
export const POST = route(async (req, v) => {
  const b = await parseBody(req, createBody);
  const page = await createPage(v, b);
  return NextResponse.json({ page }, { status: 201 });
});
