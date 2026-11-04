import { canEditDesignSets, DesignSetError } from "@/lib/design-sets";
import { proposeFromUrl } from "@/lib/design-sets/fetch-site";
import { apiRoute, fromUrlBody, parseBody } from "@/lib/artifacts/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** POST { url }: read a website (mux reader, else a guarded fetch) and propose colours, fonts and a logo. Nothing is saved. */
export const POST = apiRoute(async (req, v) => {
  if (!canEditDesignSets(v)) throw new DesignSetError(403, "Only people who can change this graph can make design sets.");
  const { url } = await parseBody(req, fromUrlBody);
  return { proposal: await proposeFromUrl(v, url) };
});
