/** Route plumbing for /api/export and /api/account: the signed-in person, zod bodies, JSON `{ error }` replies. */
import { z } from "zod";
import { requireUserApi, type Viewer } from "@/lib/auth";
import { AuthError, handle, parseBody } from "@/lib/auth/http";
import { startDataSafetyScheduler } from "@/lib/backup/scheduler";
import { DeletionError } from "./deletion";
import { ExportError, type ExportRow } from "./jobs";

export function route(fn: (req: Request, v: Viewer) => Promise<Response>) {
  return (req: Request) => handle(async () => {
    startDataSafetyScheduler();
    const v = await requireUserApi();
    try {
      return await fn(req, v);
    } catch (e) {
      if (e instanceof ExportError) throw new AuthError(e.status, e.message);
      if (e instanceof DeletionError) throw new AuthError(e.status, e.message, e.extra);
      throw e;
    }
  });
}

export function routeWithParams<P>(fn: (req: Request, v: Viewer, params: P) => Promise<Response>) {
  return (req: Request, ctx: { params: Promise<P> }) => route(async (r, v) => fn(r, v, await ctx.params))(req);
}

export const parseJson = <T extends z.ZodType>(req: Request, schema: T) => parseBody(req, schema);
export const uuid = z.string().uuid("That isn't a valid id.");

/** What the browser sees of an export (no paths, no internal ids beyond the export's own). */
export function exportView(r: ExportRow) {
  return {
    id: r.id, scope: r.scope, graphId: r.graphId, status: r.status, progress: r.progress, error: r.error,
    createdAt: r.createdAt, finishedAt: r.finishedAt, expiresAt: r.expiresAt,
    bytes: typeof r.info.bytes === "number" ? r.info.bytes : null,
    counts: (r.info.counts as Record<string, number> | undefined) ?? null,
    downloadUrl: r.status === "ready" && r.expiresAt && r.expiresAt.getTime() > Date.now() ? `/api/export/${r.id}/download` : null,
  };
}

