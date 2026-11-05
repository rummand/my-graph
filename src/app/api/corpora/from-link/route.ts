import { NextResponse } from "next/server";
import { addFromLink } from "@/lib/corpus/work";
import { fromLinkBody } from "@/lib/corpus/schemas";
import { parseBody, route } from "@/lib/compliance/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST { url }: "Add from a link". Looks at the page (what it is, its name, who issued it), creates the rule set as a
 * draft and starts the crawl and the four readings in the background. Returns at once with the new rule set's id.
 */
export const POST = route(async (req, v) => {
  const { url } = await parseBody(req, fromLinkBody);
  return NextResponse.json(await addFromLink(v, url), { status: 201 });
});
