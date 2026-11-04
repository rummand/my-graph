/**
 * CONTRACT: what the assistant remembers in a graph (preferences, family rules, notes), with provenance.
 * Owned by the memory workstream; signatures are fixed, bodies are stubs until it lands.
 * Every function is scoped to the viewer's current graph and respects visibility.
 */
import type { Viewer } from "@/lib/auth";

export type MemoryKind = "preference" | "rule" | "fact" | "note";
export type MemoryOrigin = "chat" | "upload" | "external" | "manual" | "automation";
export type MemoryStatus = "active" | "pending" | "paused";

export type Memory = {
  id: string; kind: MemoryKind; text: string; aboutNodeIds: string[]; origin: MemoryOrigin; status: MemoryStatus;
  conversationId: string | null; messageId: string | null; sourceId: string | null; runId: string | null; quote: string | null;
  confidence: number; visibility: "private" | "parents" | "household"; ownerId: string; ownerName: string;
  createdByKind: "user" | "assistant"; createdAt: Date; updatedAt: Date; lastUsedAt: Date | null;
};

export type MemoryInput = {
  kind: MemoryKind; text: string; aboutNodeIds?: string[]; origin: MemoryOrigin; createdByKind: "user" | "assistant";
  conversationId?: string; messageId?: string; sourceId?: string; runId?: string; quote?: string; confidence?: number;
  visibility?: "private" | "parents" | "household";
};

export async function listMemories(_v: Viewer, _opts: { status?: MemoryStatus | "all"; kind?: MemoryKind; aboutNodeId?: string; q?: string } = {}): Promise<Memory[]> {
  return [];
}

/** Saves a memory. Memories from outside content (origin "external"/"upload") are stored as pending until confirmed. */
export async function addMemory(_v: Viewer, _input: MemoryInput): Promise<Memory | null> {
  return null;
}

export async function updateMemory(_v: Viewer, _id: string, _patch: Partial<Pick<Memory, "text" | "kind" | "status" | "aboutNodeIds" | "visibility">>): Promise<Memory | null> {
  return null;
}

export async function deleteMemory(_v: Viewer, _id: string): Promise<boolean> {
  return false;
}

/**
 * The active memories and rules the assistant should apply right now, as a prompt-ready block plus the items
 * (so callers can mark them used and cite them). Only active memories the viewer may read; never pending ones.
 */
export async function memoryContext(_v: Viewer, _opts: { question?: string; limit?: number } = {}): Promise<{ text: string; items: Memory[] }> {
  return { text: "", items: [] };
}

export async function markMemoriesUsed(_v: Viewer, _ids: string[]): Promise<void> {}
