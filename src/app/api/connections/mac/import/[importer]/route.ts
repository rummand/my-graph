/**
 * POST /api/connections/mac/import/<imessage|apple_notes> (helper token): one batch from the helper,
 * { runId, batch, phase?, lastRowId?, notesCursor?, covered?, final?, device?, data }. `data` is checked against the
 * importer's schema (imessagePayload / appleNotesPayload), cut down to what the person chose, kept as a library source
 * of this connection (the same batch again updates it) and read by the importer, which proposes a change set. Counts
 * against the person's import limit; 429 carries Retry-After.
 */
import { z } from "zod";
import { ConnectionError } from "@/lib/connectors";
import { batchEnvelope, DOOR_MAX_BYTES } from "@/lib/connectors/mac/config";
import { helperRoute, readJson, tooMany } from "@/lib/connectors/mac/http";
import { importBatch } from "@/lib/connectors/mac/server";
import { hit } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const params = z.object({ importer: z.enum(["imessage", "apple_notes"]) });

export const POST = helperRoute(async (req, a, ctx: { params: Promise<{ importer: string }> }) => {
  const p = params.safeParse(await ctx.params);
  if (!p.success) throw new ConnectionError(404, "The Mac helper sends Messages (imessage) or Notes (apple_notes).");
  const rate = await hit("import", a.v.id);
  if (!rate.allowed) throw tooMany(rate.retryAfterSec);
  const env = batchEnvelope.safeParse(await readJson(req, DOOR_MAX_BYTES));
  if (!env.success) throw new ConnectionError(400, env.error.issues[0]?.message ?? "That batch isn't in the expected shape.");
  const out = await importBatch(a, p.data.importer, env.data);
  return Response.json(out, { status: out.sourceId && !out.duplicate ? 201 : 200, headers: { "cache-control": "no-store" } });
});
