import { fileStream } from "@/lib/storage/file-stream";
import { z } from "zod";
import { audit } from "@/lib/auth";
import { parseParams } from "@/lib/auth/http";
import { downloadable } from "@/lib/export";
import { routeWithParams, uuid } from "@/lib/export/http";

const params = z.object({ id: uuid });

/** GET: the zip, for the person who asked for it, until 24 hours after it was ready. */
export const GET = routeWithParams<{ id: string }>(async (_req, v, p) => {
  const { id } = parseParams(p, params);
  const { row, file, size } = await downloadable(v.id, id);
  await audit(v, "account.export", { type: row.scope === "graph" ? "graph" : "user", id: row.graphId ?? v.id });
  const day = (row.finishedAt ?? new Date()).toISOString().slice(0, 10);
  const name = `my-graph-${row.scope === "graph" ? "graph" : "account"}-${day}.zip`;
  return new Response(fileStream(file), {
    headers: {
      "Content-Type": "application/zip", "Content-Length": String(size),
      "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    },
  });
});
