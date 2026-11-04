import { isPlatformAdmin } from "@/lib/plans";
import { CONNECTORS, connectorInfo, createConnection, listConnections, offeredIn } from "@/lib/connectors";
import { createBody, parseJson, route } from "@/lib/connectors/http";

/** GET: my connections in this graph, and the connectors this graph offers. Secrets are never included. */
export const GET = route(async (_req, v) => ({
  connections: await listConnections(v),
  connectors: offeredIn(v.graphKind, isPlatformAdmin(v)).map(connectorInfo),
  all: CONNECTORS.length,
}));

/** POST { connector, label?, config, secrets, everyMinutes? } → 201 { connection }. The first run starts right away. */
export const POST = route(async (req, v) => {
  const body = await parseJson(req, createBody);
  const connection = await createConnection(v, body);
  return Response.json({ connection }, { status: 201 });
});
