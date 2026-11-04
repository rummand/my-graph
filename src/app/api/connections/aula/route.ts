import { z } from "zod";
import { parseJson, route } from "@/lib/connectors/http";
import { aulaStatus, startPairing } from "@/lib/connectors/aula/pairing";

/** GET: my Aula connection in this graph (if any), whether a pairing code is waiting, and who Aula says I am. */
export const GET = route(async (_req, v) => aulaStatus(v));

const startBody = z.object({
  visibility: z.enum(["private", "parents", "household"]).optional(),
  /** A local mock of Aula (development only; ignored where connectors can't reach this computer). */
  aulaBase: z.string().url().max(200).optional(),
}).strict();

/** POST { visibility? } → 201 { code, expiresAt, connectionId }: a one-time pairing code for the Connect Aula helper. */
export const POST = route(async (req, v) => {
  const body = await parseJson(req, startBody);
  return Response.json(await startPairing(v, body), { status: 201, headers: { "cache-control": "no-store" } });
});
