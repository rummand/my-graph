/** What the Memory page and panel receive: a memory plus who it is about, where it came from, and what you may do. */
import type { MemoryKind, MemoryOrigin, MemoryStatus, MemoryVisibility } from "./pure";

export type MemoryAbout = { id: string; label: string; type: string };
export type MemoryFrom = { label: string; href: string | null };

export type MemoryView = {
  id: string; kind: MemoryKind; text: string; status: MemoryStatus; origin: MemoryOrigin; visibility: MemoryVisibility;
  aboutNodeIds: string[]; about: MemoryAbout[]; from: MemoryFrom; quote: string | null; confidence: number;
  ownerId: string; ownerName: string; createdByKind: "user" | "assistant";
  createdAt: string; updatedAt: string; lastUsedAt: string | null; canEdit: boolean;
};

export type PersonOption = { id: string; label: string };
