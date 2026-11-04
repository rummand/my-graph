/**
 * "Restore as a proposal" for a retired node (server-only). Nothing is written to the graph here: the ops go into a
 * change set and a person delivers it like any other.
 */
import { and, desc, eq, gte, or } from "drizzle-orm";
import { db } from "@/db";
import { graphEvents } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { getNode, isRetired, readableEdgeIds } from "@/lib/gbrain";
import { readableSnapshots } from "@/lib/gbrain/versioning";
import { tFor } from "@/lib/i18n";
import { propose } from "./store";
import { restoreRetiredOps } from "./pure";

export type RestoreResult = { ok: true; changeSetId: string } | { ok: false; status: 403 | 404 | 409; error: string };

/** The facts that were replaced in the same moment the node was retired (5 s window, same graph). */
async function replacedAtRetire(v: Viewer, nodeId: string, retiredAt: Date): Promise<{ edgeId: string; was: unknown }[]> {
  const rows = await db.select({ edgeId: graphEvents.subjectId, was: graphEvents.fromValue, to: graphEvents.toValue }).from(graphEvents)
    .where(and(
      eq(graphEvents.graphId, v.graphId), eq(graphEvents.subjectType, "edge"), eq(graphEvents.field, "status"),
      or(eq(graphEvents.fromNodeId, nodeId), eq(graphEvents.toNodeId, nodeId)),
      gte(graphEvents.at, new Date(retiredAt.getTime() - 5_000)),
    ))
    .orderBy(desc(graphEvents.at)).limit(500);
  const replaced = rows.filter((r) => r.to === "superseded");
  if (!replaced.length) return [];
  const readable = await readableEdgeIds(v, replaced.map((r) => r.edgeId));
  return replaced.filter((r) => readable.has(r.edgeId)).map((r) => ({ edgeId: r.edgeId, was: r.was }));
}

export async function proposeRestoreNode(v: Viewer, nodeId: string, locale: "en" | "da" = "en"): Promise<RestoreResult> {
  const t = tFor(locale);
  const node = await getNode(v, nodeId);
  if (!node || node.id !== nodeId) return { ok: false, status: 404, error: t("changes.restore.notFound") };
  if (!isRetired(node.props)) return { ok: false, status: 409, error: t("changes.restore.notRetired") };
  const retiredAt = typeof node.props.retiredAt === "string" && !Number.isNaN(Date.parse(node.props.retiredAt)) ? new Date(node.props.retiredAt) : node.updatedAt;
  const replaced = await replacedAtRetire(v, nodeId, retiredAt);
  const snaps = replaced.length ? await readableSnapshots(v, { edgeIds: replaced.map((r) => r.edgeId) }) : { edges: new Map() };
  const ops = restoreRetiredOps(node, replaced, snaps.edges, t("changes.restore.note"));
  const r = await propose(v, { title: t("changes.restore.title", { name: node.label }), origin: "restore", changes: ops });
  return r ? { ok: true, changeSetId: r.id } : { ok: false, status: 403, error: t("changes.restore.notAllowed") };
}

