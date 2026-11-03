import { z } from "zod";

export const visibility = z.enum(["private", "parents", "household"], { message: "Choose Only me, Parents or Whole family." });
export const title = z.string({ message: "Give the page a title." }).trim().min(1, "Give the page a title.").max(200, "Keep the title under 200 characters.");
/** TipTap JSON; structure is checked and cleaned by sanitizeDoc in the wiki library. */
export const content = z.looseObject({ type: z.literal("doc", { message: "The page content isn't a document." }) });

export const createBody = z.object({ title, visibility: visibility.optional(), content: content.optional() });

export const patchBody = z.object({
  version: z.number().int().min(1).optional(),
  title: title.optional(),
  content: content.optional(),
  visibility: visibility.optional(),
  force: z.boolean().optional(),
}).refine((b) => b.title !== undefined || b.content !== undefined || b.visibility !== undefined, { message: "Nothing to save." })
  .refine((b) => (b.title === undefined && b.content === undefined) || b.version !== undefined, { message: "Send the page version you were editing.", path: ["version"] });

export const listQuery = z.object({
  q: z.string().trim().max(200, "Search for something shorter.").optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const restoreBody = z.object({
  revisionId: z.uuid({ message: "That version id isn't valid." }),
  version: z.number().int().min(1, "Send the current page version."),
});
