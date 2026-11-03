/**
 * Ingestion contract (owned by the library workstream). Server-only.
 * Stores the original unchanged (content-addressed), extracts text (PDF, DOCX, images via OCR, audio via mux), chunks
 * and embeds it, then asks mux to extract entities/events/facts and writes them into GBrain with provenance pointing
 * at the exact chunk and quote.
 */
import type { Viewer } from "@/lib/auth";

/** Save an upload and queue processing. Returns the new source id immediately. */
export async function ingestFile(v: Viewer, file: File, opts?: { visibility?: "private" | "parents" | "household"; sensitive?: boolean }): Promise<{ sourceId: string; duplicate: boolean }> {
  throw new Error("ingest.ingestFile not implemented");
}

/** Process a text source that already exists (wiki page saved, chat note): chunk, embed, extract facts. */
export async function ingestText(v: Viewer, sourceId: string): Promise<void> {
  throw new Error("ingest.ingestText not implemented");
}
