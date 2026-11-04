import { runNow } from "@/lib/connectors";
import { parseId, route } from "@/lib/connectors/http";

type Ctx = { params: Promise<{ id: string }> };

/** POST: check this connection now. 202 when started; 409 when paused or already checking. */
export const POST = route(async (_req, v, { params }: Ctx) => {
  await runNow(v, parseId((await params).id));
  return Response.json({ started: true }, { status: 202 });
});
