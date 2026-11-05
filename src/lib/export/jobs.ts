/**
 * Exports as background work (server-only). A request makes a `data_exports` row; the zip is built by the jobs
 * queue (kind "export.build", when src/lib/jobs/handlers.ts registers `exportBuildJob`) or, until then, in this
 * process. The finished zip sits in EXPORT_DIR (default: next to the uploads, /data/exports on Railway) for 24 hours,
 * downloadable only by the person who asked; the sweep removes it after that.
 */
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { dataExports } from "@/db/schema";
import { pathFor, uploadDir } from "@/lib/storage";
import { assembleExport, type GraphDataset } from "./format";
import { exportPlan, loadAccount, loadGraph } from "./load";
import { writeZip } from "./zip";

export const EXPORT_TTL_MS = 24 * 60 * 60_000;
export const MAX_PER_DAY = 10;
export type ExportRow = typeof dataExports.$inferSelect;

export class ExportError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = "ExportError"; }
}

export function exportDir(env: Record<string, string | undefined> = process.env): string {
  return path.resolve(env.EXPORT_DIR || path.join(path.dirname(uploadDir()), "exports"));
}

/** The zip's path for an export id (ids are UUIDs; anything else is refused). */
export function exportFilePath(id: string): string {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid export id");
  return path.join(exportDir(), `${id}.zip`);
}

/** Ask for an export. Checks scope and limits; returns the new row (status queued). */
export async function createExport(userId: string, input: { scope: "graph"; graphId: string } | { scope: "account" }): Promise<ExportRow> {
  const plan = await exportPlan(userId, input.scope, input.scope === "graph" ? input.graphId : null);
  if (input.scope === "graph" && !plan.length) throw new ExportError(403, "You can export a graph you own. Ask its owner for a copy of this one.");
  if (!plan.length) throw new ExportError(404, "There is nothing to export yet.");
  const active = await db.select({ id: dataExports.id }).from(dataExports)
    .where(and(eq(dataExports.userId, userId), inArray(dataExports.status, ["queued", "running"]))).limit(1);
  if (active.length) throw new ExportError(409, "An export is already being made. It will be ready in a moment.");
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(dataExports)
    .where(and(eq(dataExports.userId, userId), gte(dataExports.createdAt, new Date(Date.now() - 86_400_000))));
  if (n >= MAX_PER_DAY) throw new ExportError(429, `You can make ${MAX_PER_DAY} exports a day. Try again tomorrow.`);
  const [row] = await db.insert(dataExports).values({
    userId, scope: input.scope, graphId: input.scope === "graph" ? input.graphId : null, status: "queued",
  }).returning();
  return row;
}

type Progress = (p: { step: string; done?: number; total?: number }) => Promise<void>;

/**
 * Build the zip for an export. Safe to call again (a retry rebuilds from scratch). Throws on failure after
 * recording it on the row, so the jobs queue can retry.
 */
export async function runExportBuild(exportId: string, onProgress?: Progress): Promise<void> {
  const [row] = await db.select().from(dataExports).where(eq(dataExports.id, exportId));
  if (!row || row.status === "ready" || row.status === "expired") return;
  await db.update(dataExports).set({ status: "running", startedAt: new Date(), error: null, progress: { step: "starting" } }).where(eq(dataExports.id, exportId));
  const progress = async (p: { step: string; done?: number; total?: number }) => {
    await db.update(dataExports).set({ progress: p }).where(eq(dataExports.id, exportId)).catch(() => {});
    await onProgress?.(p);
  };
  try {
    const who = await loadAccount(row.userId);
    if (!who) throw new ExportError(404, "The account no longer exists.");
    const plan = await exportPlan(row.userId, row.scope === "graph" ? "graph" : "account", row.graphId);
    if (!plan.length) throw new ExportError(403, row.scope === "graph" ? "You no longer own this graph, so it can't be exported." : "There is nothing to export.");
    const graphs: GraphDataset[] = [];
    for (let i = 0; i < plan.length; i++) {
      await progress({ step: "collecting", done: i, total: plan.length });
      const d = await loadGraph(row.userId, plan[i].graphId, plan[i].mode);
      if (d) graphs.push(d);
    }
    await progress({ step: "zipping" });
    const { entries, manifest } = assembleExport({
      scope: row.scope === "graph" ? "graph" : "account", createdAt: new Date(), person: who.person,
      account: row.scope === "account" ? who.account : null, allowedGraphIds: plan.map((p) => p.graphId), graphs,
    });
    await mkdir(exportDir(), { recursive: true, mode: 0o700 });
    const out = await writeZip(entries, manifest, exportFilePath(row.id), pathFor);
    const now = new Date();
    await db.update(dataExports).set({
      status: "ready", finishedAt: now, expiresAt: new Date(now.getTime() + EXPORT_TTL_MS), progress: { step: "done" },
      info: { bytes: out.bytes, sha256: out.sha256, counts: manifest.totals, graphs: manifest.graphs.length, missingFiles: out.missingFiles.length },
    }).where(eq(dataExports.id, row.id));
  } catch (e) {
    const msg = e instanceof ExportError ? e.message : "The export couldn't be made. Try again in a moment.";
    console.error("[export] build failed", row.id, e instanceof Error ? e.message : e);
    await db.update(dataExports).set({ status: "failed", error: msg, finishedAt: new Date(), progress: null }).where(eq(dataExports.id, row.id));
    await rm(exportFilePath(row.id), { force: true }).catch(() => {});
    throw e;
  }
}

/** Handler for the jobs queue (kind "export.build", payload { exportId }). Register in src/lib/jobs/handlers.ts. */
export async function exportBuildJob(job: { payload: Record<string, unknown>; userId: string }, ctx: { progress: (p: { step: string; done?: number; total?: number }) => Promise<void> }): Promise<void> {
  const id = typeof job.payload.exportId === "string" ? job.payload.exportId : "";
  const [row] = await db.select({ userId: dataExports.userId }).from(dataExports).where(eq(dataExports.id, id));
  if (!row || row.userId !== job.userId) return; // deleted, or not theirs: nothing to do
  await runExportBuild(id, ctx.progress);
}

const building = (): Set<string> => {
  const g = globalThis as unknown as { __mgExportsBuilding?: Set<string> };
  return (g.__mgExportsBuilding ??= new Set());
};

/** Build in this process (fire-and-forget; the sweep picks it up again after a restart). */
export function buildInProcess(exportId: string): void {
  const b = building();
  if (b.has(exportId)) return;
  b.add(exportId);
  void runExportBuild(exportId).catch(() => { /* recorded on the row */ }).finally(() => b.delete(exportId));
}

export async function listExports(userId: string): Promise<ExportRow[]> {
  return db.select().from(dataExports).where(eq(dataExports.userId, userId)).orderBy(desc(dataExports.createdAt)).limit(10);
}

/** The ready zip for its owner, or why not. */
export async function downloadable(userId: string, id: string): Promise<{ row: ExportRow; file: string; size: number }> {
  const [row] = await db.select().from(dataExports).where(and(eq(dataExports.id, id), eq(dataExports.userId, userId)));
  if (!row) throw new ExportError(404, "This export doesn't exist.");
  if (row.status !== "ready") throw new ExportError(409, row.status === "expired" ? "This download has expired. Make a new export." : "This export isn't ready yet.");
  if (!row.expiresAt || row.expiresAt.getTime() <= Date.now()) throw new ExportError(410, "This download has expired. Make a new export.");
  const file = exportFilePath(row.id);
  try {
    const s = await stat(file);
    return { row, file, size: s.size };
  } catch {
    throw new ExportError(410, "This download is no longer on the server. Make a new export.");
  }
}

export async function deleteExport(userId: string, id: string): Promise<boolean> {
  const rows = await db.delete(dataExports).where(and(eq(dataExports.id, id), eq(dataExports.userId, userId))).returning({ id: dataExports.id });
  if (rows.length) await rm(exportFilePath(id), { force: true }).catch(() => {});
  return rows.length > 0;
}

/**
 * Housekeeping: expire downloads after 24 hours (file removed), restart exports a restart interrupted (in-process
 * builds; queued jobs resume by themselves), give up on ones stuck for hours, forget old rows after 30 days.
 */
export async function sweepExports(now = new Date()): Promise<void> {
  const expired = await db.update(dataExports).set({ status: "expired" })
    .where(and(eq(dataExports.status, "ready"), lt(dataExports.expiresAt, now))).returning({ id: dataExports.id });
  for (const e of expired) await rm(exportFilePath(e.id), { force: true }).catch(() => {});

  const stale = await db.select().from(dataExports)
    .where(and(inArray(dataExports.status, ["queued", "running"]), lt(dataExports.createdAt, new Date(now.getTime() - 10 * 60_000))));
  for (const r of stale) {
    const live = await db.execute<{ n: number }>(sql`select count(*)::int as n from jobs where kind = 'export.build' and status in ('queued', 'running') and payload->>'exportId' = ${r.id}`);
    if (Number(live[0]?.n ?? 0) > 0) continue;
    if (now.getTime() - r.createdAt.getTime() > 3 * 60 * 60_000) {
      await db.update(dataExports).set({ status: "failed", error: "The export took too long and was stopped. Try again.", finishedAt: now }).where(eq(dataExports.id, r.id));
      continue;
    }
    buildInProcess(r.id);
  }

  await db.delete(dataExports).where(and(inArray(dataExports.status, ["expired", "failed"]), lt(dataExports.createdAt, new Date(now.getTime() - 30 * 86_400_000))));
}
