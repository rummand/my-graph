/**
 * Ingestion contract (owned by the library workstream). Server-only.
 * Stores the original unchanged (content-addressed), extracts text (PDF, DOCX, images via OCR, audio via mux), chunks
 * and embeds it, then asks mux to extract entities/events/facts and writes them into GBrain with provenance pointing
 * at the exact chunk and quote. Reading runs from the durable job queue (src/lib/jobs), so a restart never loses it.
 */
import { importerById } from "@/lib/importers/registry";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { sources } from "@/db/schema";
import { audit, type Viewer } from "@/lib/auth";
import { putFile, sha256Hex } from "@/lib/storage";
import { scopeOf } from "@/lib/graphs/pure";
import { IngestError } from "./errors";
import { detectFileType, MAX_UPLOAD_BYTES } from "./mime";
import { docKeyOf, nameKeyOf } from "./revisions";
import { rememberName } from "./revisions-store";
import { enqueueSourceRead, waitForJob } from "@/lib/jobs/queue";

export { IngestError };

/** Save an upload and queue processing. Returns the new source id immediately. */
export async function ingestFile(v: Viewer, file: File, opts?: { visibility?: "private" | "parents" | "household"; sensitive?: boolean }): Promise<{ sourceId: string; duplicate: boolean; sameAs?: string }> {
  const name = (file.name || "Untitled").split(/[\\/]/).pop()!.slice(0, 250);
  if (file.size === 0) throw new IngestError(400, `"${name}" is empty.`);
  if (file.size > MAX_UPLOAD_BYTES) throw new IngestError(413, `"${name}" is ${(file.size / 1024 / 1024).toFixed(0)} MB. The limit is 50 MB per file.`);

  if (!scopeOf(v).canWrite) throw new IngestError(403, "You can look at this graph but not add files to it.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = detectFileType(name, file.type, bytes.subarray(0, 8192));
  if (!type.ok) throw new IngestError(415, type.reason);
  const importer = importerById(type.importer);
  if (importer?.graphKinds?.length && !importer.graphKinds.includes(v.graphKind)) {
    throw new IngestError(415, `"${name}" is ${importer.label}, which can only be imported into a ${importer.graphKinds.join(" or ")} graph.`);
  }

  const sha256 = sha256Hex(bytes);
  // The same bytes again, under any name: not stored twice. The other name is remembered on the file we have.
  const [dup] = await db.select({ id: sources.id, title: sources.title }).from(sources)
    .where(and(eq(sources.graphId, v.graphId), eq(sources.ownerId, v.id), eq(sources.sha256, sha256))).limit(1);
  if (dup) {
    if (dup.title !== name) await rememberName(dup.id, name);
    return { sourceId: dup.id, duplicate: true, sameAs: dup.title };
  }
  // What tells a later upload that it is this document again, or a new version of it (see revisions.ts).
  const docKey = await docKeyOf({ bytes, kind: type.kind, ext: type.ext });
  const nameKey = nameKeyOf(name, type.kind);

  const stored = await putFile(bytes);
  const [row] = await db.insert(sources).values({
    householdId: v.graphHouseholdId,
    graphId: v.graphId,
    ownerId: v.id,
    // A single email is a message of a correspondence; everything else (mail imports included) is an upload.
    kind: type.kind === "email" ? "email" : "upload",
    title: name,
    mime: type.mime,
    storageKey: stored.storageKey,
    sha256,
    size: stored.size,
    docKey,
    nameKey,
    meta: { originalName: name, kind: type.kind, declaredMime: file.type || null, ...(importer ? { importer: importer.id } : {}) },
    status: "pending",
    visibility: opts?.visibility ?? "private",
    sensitive: (opts?.sensitive ?? false) || !!importer?.sensitive,
  }).returning({ id: sources.id });

  void audit(v, "library.upload", { type: "source", id: row.id }, { mime: type.mime, size: stored.size }).catch(() => {});
  await enqueueSourceRead(v.id, row.id, { fromFile: true, priority: 10 });
  return { sourceId: row.id, duplicate: false };
}

/**
 * Process a text source that already exists (wiki page saved, chat note): chunk, embed, extract facts.
 * Resolves when processing has finished (callers that don't want to wait can `void` it). Progress and failures are
 * recorded on the source row (status / error / meta); this function does not throw for processing failures.
 */
export async function ingestText(v: Viewer, sourceId: string): Promise<void> {
  const [src] = await db.select({ ownerId: sources.ownerId, graphId: sources.graphId }).from(sources).where(eq(sources.id, sourceId)).limit(1);
  if (!src) throw new IngestError(404, "Source not found.");
  if (src.ownerId !== v.id || src.graphId !== v.graphId) throw new IngestError(403, "Only the owner can process this source, in its own graph.");
  const job = await enqueueSourceRead(v.id, sourceId, { fromFile: false, priority: 10 });
  if (job) await waitForJob(job.id);
}

/** Run the whole pipeline again for an uploaded source (Retry, "Read it again", connectors). Queues it; returns at once. */
export async function reprocessSource(v: Viewer, sourceId: string): Promise<void> {
  const [src] = await db.select({ ownerId: sources.ownerId, graphId: sources.graphId, storageKey: sources.storageKey }).from(sources).where(eq(sources.id, sourceId)).limit(1);
  if (!src) throw new IngestError(404, "Source not found.");
  if (src.ownerId !== v.id || src.graphId !== v.graphId) throw new IngestError(403, "Only the person who added this file can reprocess it.");
  await db.update(sources).set({ status: "pending", error: null }).where(eq(sources.id, sourceId));
  await enqueueSourceRead(v.id, sourceId, { fromFile: !!src.storageKey, priority: 20 });
}
