/**
 * The Brain Keeper's write path into memory (server-only). The keeper runs as one person in one graph and may change
 * only memories the assistant wrote for that person: every write re-checks graph, owner and createdByKind in the
 * WHERE clause, so a memory a person wrote themselves can never be rewritten, merged away or retired from here.
 * New memories go through addMemory (same duplicate check, origin check and visibility narrowing as everything else).
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { memories } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { canEditMemory, cleanText, MEMORY_MAX_CHARS, memoryAllowed, type MemoryKind, type MemoryVisibility } from "./pure";
import { listMemories } from "./index";

export type KeeperMemoryRow = {
  id: string; kind: MemoryKind; text: string; status: "active" | "pending" | "paused"; createdByKind: "user" | "assistant";
  visibility: MemoryVisibility; mine: boolean; canEdit: boolean; aboutNodeIds: string[];
};

/** Every memory this person may read in the graph, as the keeper sees it. */
export async function keeperMemories(v: Viewer): Promise<KeeperMemoryRow[]> {
  if (!memoryAllowed(v)) return [];
  const list = await listMemories(v, { status: "all" });
  return list.map((m) => ({
    id: m.id, kind: m.kind, text: m.text, status: m.status, createdByKind: m.createdByKind, visibility: m.visibility,
    mine: m.ownerId === v.id, canEdit: canEditMemory(v, { ownerId: m.ownerId, visibility: m.visibility, graphId: v.graphId }),
    aboutNodeIds: m.aboutNodeIds,
  }));
}

/** Only the assistant's memories of this person, in this graph. */
const keepersOwn = (v: Viewer, ids: string[]) => and(
  inArray(memories.id, ids), eq(memories.graphId, v.graphId), eq(memories.ownerId, v.id), eq(memories.createdByKind, "assistant"),
);

const VIS_RANK: Record<MemoryVisibility, number> = { private: 0, parents: 1, household: 2 };

/**
 * Change one of the keeper's memories. Visibility only ever narrows; status moves active ↔ paused only (nothing the
 * keeper does promotes a pending memory). Returns false when the memory is not the keeper's to change.
 */
export async function keeperUpdate(v: Viewer, id: string, patch: { text?: string | null; kind?: MemoryKind | null; visibility?: MemoryVisibility | null; status?: "paused" | null }): Promise<boolean> {
  const [m] = await db.select({ visibility: memories.visibility, status: memories.status }).from(memories).where(keepersOwn(v, [id])).limit(1);
  if (!m) return false;
  const set: Partial<typeof memories.$inferInsert> = { updatedAt: new Date() };
  if (patch.text) {
    const t = cleanText(patch.text, MEMORY_MAX_CHARS);
    if (t.length < 2) return false;
    set.text = t;
  }
  if (patch.kind) set.kind = patch.kind;
  if (patch.visibility && VIS_RANK[patch.visibility] < VIS_RANK[m.visibility]) set.visibility = patch.visibility;
  if (patch.status === "paused") set.status = "paused";
  const out = await db.update(memories).set(set).where(keepersOwn(v, [id])).returning({ id: memories.id });
  return out.length > 0;
}

/** Remove near-copies after a merge (their words are in the journal). Only the keeper's own memories. */
export async function keeperDrop(v: Viewer, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const out = await db.delete(memories).where(keepersOwn(v, ids)).returning({ id: memories.id });
  return out.map((r) => r.id);
}
