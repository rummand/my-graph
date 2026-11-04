import { graphDefaultSetId, setGraphDefault } from "@/lib/design-sets";
import { apiRoute, defaultBody, parseBody } from "@/lib/artifacts/http";

export const dynamic = "force-dynamic";

/** GET: the set new documents in this graph start with. */
export const GET = apiRoute(async (_req, v) => ({ designSetId: await graphDefaultSetId(v) }));

/** PUT { designSetId }: change it for this graph. */
export const PUT = apiRoute(async (req, v) => ({ designSetId: await setGraphDefault(v, (await parseBody(req, defaultBody)).designSetId) }));
