/**
 * Server side of importers: keep a batch (from the iPhone app, the Mac helper or a connector's sync) as a library
 * source and queue it for reading, which runs its importer and proposes a change set. Server-only.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { sources } from "@/db/schema";
import { audit, type Viewer } from "@/lib/auth";
import { scopeOf } from "@/lib/graphs/pure";
import { IngestError } from "@/lib/ingest/errors";
import { enqueueSourceRead } from "@/lib/jobs/queue";
import { putFile, sha256Hex } from "@/lib/storage";
import { importerById } from "./registry";

export type ImportPayloadInput = {
  bytes: Uint8Array;
  /** Shown as the source's title until the importer gives a better one. */
  title: string;
  /** A connector's sync: the connection and the item's id at the source. The same item is updated, not duplicated. */
  connectionId?: string | null;
  externalId?: string | null;
  visibility?: "private" | "parents" | "household";
  sensitive?: boolean;
};

/** Store the batch as a source of `importerId` and queue it. Identical batches are not stored twice. */
export async function importPayload(v: Viewer, importerId: string, input: ImportPayloadInput): Promise<{ sourceId: string; duplicate: boolean }> {
  const importer = importerById(importerId);
  if (!importer) throw new IngestError(404, "There is no importer with that name.");
  if (!scopeOf(v).canWrite) throw new IngestError(403, "You can look at this graph but not add to it.");
  if (importer.graphKinds?.length && !importer.graphKinds.includes(v.graphKind)) {
    throw new IngestError(409, `${importer.label} can only be imported into a ${importer.graphKinds.join(" or ")} graph.`);
  }
  const sha256 = sha256Hex(input.bytes);
  const [dup] = await db.select({ id: sources.id, status: sources.status }).from(sources)
    .where(and(eq(sources.graphId, v.graphId), eq(sources.ownerId, v.id), eq(sources.sha256, sha256))).limit(1);
  if (dup) {
    // The same batch again: read it again only if the last reading failed.
    if (dup.status === "failed") {
      await db.update(sources).set({ status: "pending", error: null }).where(eq(sources.id, dup.id));
      await enqueueSourceRead(v.id, dup.id, { fromFile: true, priority: 10 });
    }
    return { sourceId: dup.id, duplicate: true };
  }

  const stored = await putFile(input.bytes);
  const sensitive = (input.sensitive ?? false) || !!importer.sensitive;
  const title = input.title.replace(/\s+/g, " ").trim().slice(0, 250) || importer.label;

  if (input.connectionId && input.externalId) {
    const [prev] = await db.select({ id: sources.id, meta: sources.meta }).from(sources)
      .where(and(eq(sources.graphId, v.graphId), eq(sources.connectionId, input.connectionId), eq(sources.externalId, input.externalId))).limit(1);
    if (prev) {
      await db.update(sources).set({
        storageKey: stored.storageKey, sha256, size: stored.size, mime: importer.mime, status: "pending", error: null, fetchedAt: new Date(),
        meta: { ...(prev.meta ?? {}), importer: importer.id, fetchedAt: new Date().toISOString() },
      }).where(eq(sources.id, prev.id));
      await enqueueSourceRead(v.id, prev.id, { fromFile: true, priority: 30 });
      return { sourceId: prev.id, duplicate: false };
    }
  }

  const [row] = await db.insert(sources).values({
    householdId: v.graphHouseholdId,
    graphId: v.graphId,
    ownerId: v.id,
    kind: input.connectionId ? "connector" : "sync",
    title,
    mime: importer.mime,
    storageKey: stored.storageKey,
    sha256,
    size: stored.size,
    meta: { importer: importer.id, kind: "import", ...(input.connectionId ? { fetchedAt: new Date().toISOString() } : {}) },
    status: "pending",
    visibility: importer.privateOnly ? "private" : input.visibility ?? "private",
    sensitive,
    connectionId: input.connectionId ?? null,
    externalId: input.externalId ?? null,
    ...(input.connectionId ? { fetchedAt: new Date() } : {}),
  }).returning({ id: sources.id });

  void audit(v, "library.import", { type: "source", id: row.id }, { importer: importer.id, size: stored.size }).catch(() => {});
  await enqueueSourceRead(v.id, row.id, { fromFile: true, priority: input.connectionId ? 30 : 10 });
  return { sourceId: row.id, duplicate: false };
}
