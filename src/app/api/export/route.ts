import { z } from "zod";
import { audit } from "@/lib/auth";
import { HANDLERS } from "@/lib/jobs/handlers";
import { enqueueJob, type JobKind } from "@/lib/jobs";
import { buildInProcess, createExport, listExports } from "@/lib/export";
import { exportView, parseJson, route, uuid } from "@/lib/export/http";

const body = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("graph"), graphId: uuid }),
  z.object({ scope: z.literal("account") }),
]);

/** GET: my recent exports. */
export const GET = route(async (_req, v) => Response.json({ exports: (await listExports(v.id)).map(exportView) }));

/**
 * POST { scope: "graph", graphId } | { scope: "account" } → 202 { export }. A graph export needs the graph to be
 * yours; an account export covers every graph you belong to (only what you added, in graphs you don't own).
 * Built in the background: through the jobs queue when its handler is registered, otherwise in this process.
 */
export const POST = route(async (req, v) => {
  const input = await parseJson(req, body);
  const row = await createExport(v.id, input);
  const kind = "export.build" as JobKind;
  if (kind in HANDLERS) {
    // Jobs need a graph: the exported graph, or the one the person is working in.
    await enqueueJob({ graphId: row.graphId ?? v.graphId, userId: v.id, kind, subjectId: null, payload: { exportId: row.id }, maxAttempts: 2 });
  } else {
    buildInProcess(row.id);
  }
  await audit(v, "account.export_requested", { type: row.scope === "graph" ? "graph" : "user", id: row.graphId ?? v.id });
  return Response.json({ export: exportView(row) }, { status: 202 });
});
