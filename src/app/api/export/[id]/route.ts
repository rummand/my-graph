import { z } from "zod";
import { AuthError, parseParams } from "@/lib/auth/http";
import { deleteExport, listExports } from "@/lib/export";
import { exportView, routeWithParams, uuid } from "@/lib/export/http";

const params = z.object({ id: uuid });

/** GET: one of my exports (to follow its progress). */
export const GET = routeWithParams<{ id: string }>(async (_req, v, p) => {
  const { id } = parseParams(p, params);
  const row = (await listExports(v.id)).find((r) => r.id === id);
  if (!row) throw new AuthError(404, "This export doesn't exist.");
  return Response.json({ export: exportView(row) });
});

/** DELETE: remove one of my exports (and its file) now instead of after 24 hours. */
export const DELETE = routeWithParams<{ id: string }>(async (_req, v, p) => {
  const { id } = parseParams(p, params);
  if (!(await deleteExport(v.id, id))) throw new AuthError(404, "This export doesn't exist.");
  return Response.json({ ok: true });
});
