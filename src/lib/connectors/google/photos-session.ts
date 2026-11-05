/**
 * Opening and watching a Google Photos picking session for a connection (server-only). The token stays here: the
 * browser only gets Google's picker address and polls this server, which asks Google. When the person has finished
 * picking, the connection runs and brings the photos in (see photos.ts).
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { connections } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { scopeOf } from "@/lib/graphs/pure";
import { decryptSecrets } from "../crypto";
import { ConnectorError } from "../errors";
import { apiBase } from "../oauth/providers";
import { apiFor } from "../oauth/session";
import { cursorOf, readState } from "../state";
import { ConnectionError, kick } from "../store";
import { durationMs, googlePhotosConfig, MAX_SESSIONS, pendingSessions, type PhotosCursor, type PickingSession } from "./photos";

async function ownPhotosRow(v: Viewer, id: string) {
  if (v.role === "guest" || !scopeOf(v).canWrite) throw new ConnectionError(403, "You can look at this graph but not add photos to it.");
  const [row] = await db.select().from(connections).where(and(eq(connections.id, id), eq(connections.graphId, v.graphId), eq(connections.userId, v.id))).limit(1);
  if (!row) throw new ConnectionError(404, "This connection doesn't exist, or it isn't yours.");
  if (row.connector !== "google_photos") throw new ConnectionError(400, "Only a Google Photos connection picks photos this way.");
  if (row.status === "paused") throw new ConnectionError(409, "This connection is paused. Resume it first.");
  let secrets: Record<string, string>;
  try { secrets = decryptSecrets(row.secrets, row.id); } catch { throw new ConnectionError(400, "Sign in again first.", "signInAgain"); }
  if (!secrets.oauth) throw new ConnectionError(400, "Sign in again first.", "signInAgain");
  return { row, api: apiFor(row, secrets) };
}

function asConnectionError(e: unknown): never {
  if (e instanceof ConnectorError) throw new ConnectionError(400, e.message, e.code);
  throw e;
}

/** Open a picking session; returns Google's picker address (the person picks there) and how often to check. */
export async function createPhotosSession(v: Viewer, id: string): Promise<{ sessionId: string; pickerUri: string; pollMs: number; timeoutMs: number }> {
  const { row, api } = await ownPhotosRow(v, id);
  const r = await api({ url: `${apiBase().photosPicker}/sessions`, method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(asConnectionError);
  if (r.status !== 200) throw new ConnectionError(502, `Google didn't open the photo picker (HTTP ${r.status}). If this keeps happening, the Photos Picker API may not be turned on for this My Graph's Google app.`);
  const s = r.json<PickingSession>();
  if (!s?.id || !s.pickerUri || !/^https:\/\//.test(s.pickerUri)) throw new ConnectionError(502, "Google answered without a picker address.");
  const cfg = googlePhotosConfig.parse(row.config ?? {});
  const kept = pendingSessions(cfg, cursorOf<PhotosCursor>(readState(row.state), "photos") ?? null);
  const sessions = [...kept, { id: s.id, createdAt: new Date().toISOString() }].slice(-MAX_SESSIONS);
  await db.update(connections).set({ config: { ...(row.config ?? {}), sessions }, updatedAt: new Date() })
    .where(and(eq(connections.id, id), eq(connections.graphId, v.graphId), eq(connections.userId, v.id)));
  return {
    sessionId: s.id, pickerUri: s.pickerUri,
    pollMs: durationMs(s.pollingConfig?.pollInterval, 3000), timeoutMs: durationMs(s.pollingConfig?.timeoutIn, 10 * 60_000, 30_000, 30 * 60_000),
  };
}

export type PhotosSessionStatus = { state: "picking" | "picked" | "read" | "expired" };

/** Has the person finished picking? When they have, the connection runs now and brings the photos in. */
export async function photosSessionStatus(v: Viewer, id: string, sessionId: string): Promise<PhotosSessionStatus> {
  const { row, api } = await ownPhotosRow(v, id);
  const cfg = googlePhotosConfig.parse(row.config ?? {});
  const done = cursorOf<PhotosCursor>(readState(row.state), "photos")?.done ?? [];
  if (done.includes(sessionId)) return { state: "read" };
  if (!cfg.sessions.some((s) => s.id === sessionId)) throw new ConnectionError(404, "That picking session isn't one of this connection's.");
  const r = await api({ url: `${apiBase().photosPicker}/sessions/${encodeURIComponent(sessionId)}` }).catch(asConnectionError);
  if (r.status === 404) return { state: "expired" };
  if (r.status !== 200) throw new ConnectionError(502, `Google didn't say how the picking went (HTTP ${r.status}).`);
  const s = r.json<PickingSession>();
  if (!s?.mediaItemsSet) return { state: s?.expireTime && Date.parse(s.expireTime) < Date.now() ? "expired" : "picking" };
  // Due now: if a run is already going, the scheduler picks it up next.
  await db.update(connections).set({ nextRunAt: new Date() }).where(and(eq(connections.id, id), eq(connections.graphId, v.graphId)));
  kick(id, v.graphId);
  return { state: "picked" };
}
