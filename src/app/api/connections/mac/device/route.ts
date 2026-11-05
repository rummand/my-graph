/**
 * POST /api/connections/mac/device { deviceName, appVersion } → 201 { connectionId, token, graph: { id, name, kind } }
 * (signed in: the person's session, current graph). The My Graph for Mac app signs in without a pairing code: this
 * makes (or reuses) the person's Mac connection in the current graph and returns a token, once. Only its hash is
 * kept; it is the same kind of token the Node helper gets from pairing, so every bearer route under
 * /api/connections/mac accepts it. Signing in again replaces the previous token (helper or app).
 */
import { parseJson, route } from "@/lib/connectors/http";
import { deviceBody } from "@/lib/connectors/mac/app";
import { signInDevice } from "@/lib/connectors/mac/app-server";

export const dynamic = "force-dynamic";

export const POST = route(async (req, v) => {
  const body = await parseJson(req, deviceBody);
  return Response.json(await signInDevice(v, body), { status: 201, headers: { "cache-control": "no-store" } });
});
