/** Route plumbing for /api/memory: zod bodies and the access checks that turn into 403s with a reason. */
import { z } from "zod";
import type { Viewer } from "@/lib/auth";
import { GraphError } from "@/lib/graphs";
import { canAddMemory, memoryAllowed, MEMORY_MAX_CHARS } from "./pure";

const kind = z.enum(["preference", "rule", "fact", "note"]);
const visibility = z.enum(["private", "parents", "household"]);
const text = z.string().trim().min(2, "Write what the assistant should remember.").max(MEMORY_MAX_CHARS, `Keep it under ${MEMORY_MAX_CHARS} characters.`);
const nodeIds = z.array(z.string().uuid()).max(20, "That's a lot of people. Pick up to 20.");

export const listQuery = z.object({
  status: z.enum(["active", "pending", "paused", "all"], { message: "Status must be active, pending, paused or all." }).default("all"),
  kind: z.enum(["preference", "rule", "fact", "note"], { message: "Kind must be rule, preference, note or fact." }).optional(),
  about: z.string().uuid({ message: "That person or thing isn't in this graph." }).optional(),
  q: z.string().max(200).optional(),
});

/** People add memories by hand here; the assistant saves through addMemory directly, never through this route. */
export const createBody = z.object({
  kind: kind.default("note"),
  text,
  aboutNodeIds: nodeIds.default([]),
  visibility: visibility.default("household"),
});

export const updateBody = z.object({
  text: text.optional(),
  kind: kind.optional(),
  status: z.enum(["active", "paused"]).optional(),
  aboutNodeIds: nodeIds.optional(),
  visibility: visibility.optional(),
}).refine((b) => Object.values(b).some((x) => x !== undefined), "Nothing to change.");

export function assertMemoryReader(v: Viewer) {
  if (!memoryAllowed(v)) throw new GraphError(403, "Memory is for parents. Ask a parent if something should be remembered.");
}

export function assertMemoryWriter(v: Viewer) {
  assertMemoryReader(v);
  if (!canAddMemory(v)) throw new GraphError(403, "You can look at what's remembered in this graph but not change it. Ask its owner to make you an editor.");
}
