/** Request bodies for /api/compliance (zod). */
import { z } from "zod";
import { TARGET_TYPES } from "@/lib/corpus/pure";

export const targetType = z.enum(TARGET_TYPES);

export const checkBody = z.object({
  targetType,
  targetId: z.string().uuid("That id isn't valid."),
  /** Live text of a wiki page being edited. */
  text: z.string().max(200_000).optional(),
  /** Live content of a document being edited (blocks). */
  content: z.unknown().optional(),
  title: z.string().max(300).optional(),
  version: z.number().int().min(0).optional(),
  corpusIds: z.array(z.string().uuid()).max(20).nullish(),
  missing: z.boolean().optional(),
});

export const findingAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("accept"), reason: z.string().max(1000) }),
  z.object({ action: z.literal("fixed") }),
  z.object({ action: z.literal("reopen") }),
]);

export const targetQuery = z.object({ targetType: z.union([targetType, z.literal("graph")]), targetId: z.string().max(64).default("") });

export const targetsPut = z.object({
  targetType: z.union([targetType, z.literal("graph")]),
  targetId: z.string().max(64).default(""),
  /** null = use the graph default again. */
  corpusIds: z.array(z.string().uuid()).max(30).nullable(),
});

export const acknowledgeBody = z.object({
  targetType,
  targetId: z.string().uuid(),
  reason: z.string().max(1000),
  severities: z.array(z.enum(["blocker", "major", "minor", "info"])).optional(),
});
