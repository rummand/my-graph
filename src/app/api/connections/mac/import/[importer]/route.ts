/**
 * POST /api/connections/mac/import/<imessage|apple_notes|contacts|photos|calendar|reminders|calls> (helper or app
 * token): one batch, { runId, batch, phase?, lastRowId?, notesCursor?, covered?, final?, device?, data }. `data` is
 * checked against the importer's schema (src/lib/importers/schemas.ts), refused with 409 when that source is turned
 * off, cut down to what the person chose (and, for the app's sources, to what is new or changed since the last send),
 * kept as a library source of this connection and read by the importer, which proposes a change set. Counts against
 * the person's import limit; 429 carries Retry-After.
 */
import { z } from "zod";
import { ConnectionError } from "@/lib/connectors";
import { APP_IMPORTER_IDS } from "@/lib/connectors/mac/app";
import { importAppBatch, isNewImporter } from "@/lib/connectors/mac/app-server";
import { batchEnvelope, DOOR_MAX_BYTES } from "@/lib/connectors/mac/config";
import { helperRoute, readJson, tooMany } from "@/lib/connectors/mac/http";
import { importBatch } from "@/lib/connectors/mac/server";
import { hit } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const params = z.object({ importer: z.enum(APP_IMPORTER_IDS) });

export const POST = helperRoute(async (req, a, ctx: { params: Promise<{ importer: string }> }) => {
  const p = params.safeParse(await ctx.params);
  if (!p.success) throw new ConnectionError(404, `The Mac sends ${APP_IMPORTER_IDS.join(", ")}.`);
  const rate = await hit("import", a.v.id);
  if (!rate.allowed) throw tooMany(rate.retryAfterSec);
  const env = batchEnvelope.safeParse(await readJson(req, DOOR_MAX_BYTES));
  if (!env.success) throw new ConnectionError(400, env.error.issues[0]?.message ?? "That batch isn't in the expected shape.");
  const id = p.data.importer;
  const out = id === "imessage" || id === "apple_notes" ? await importBatch(a, id, env.data) : isNewImporter(id) ? await importAppBatch(a, id, env.data) : null;
  if (!out) throw new ConnectionError(404, "Unknown importer.");
  return Response.json(out, { status: out.sourceId && !out.duplicate ? 201 : 200, headers: { "cache-control": "no-store" } });
});
