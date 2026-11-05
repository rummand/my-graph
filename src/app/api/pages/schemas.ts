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

export const cowriteMode = z.enum(["insert", "rewrite", "page"], { message: "Choose where the assistant should write." });

/** POST /api/pages/[slug]/cowrite — the request and the page as the writer sees it now (it may have unsaved edits). */
export const cowriteBody = z.object({
  instruction: z.string({ message: "Tell the assistant what to write." }).trim().min(3, "Tell the assistant what to write.").max(2000, "Keep the request under 2,000 characters."),
  mode: cowriteMode,
  pageMarkdown: z.string().max(200_000, "This page is too long for the assistant to read in one go.").default(""),
  selectionMarkdown: z.string().max(40_000, "Select a shorter passage to rewrite.").optional(),
}).refine((b) => b.mode !== "rewrite" || !!b.selectionMarkdown?.trim(), { message: "Select the text you want rewritten first.", path: ["selectionMarkdown"] });

/** POST /api/pages/[slug]/cowrite/accept — keep the assistant's draft as its own revision. */
export const acceptBody = z.object({
  version: z.number().int().min(1, "Send the current page version."),
  content,
  instruction: z.string().trim().min(1).max(2000),
  mode: cowriteMode,
  words: z.number().int().min(0).max(1_000_000).optional(),
  sourceCount: z.number().int().min(0).max(100).optional(),
  usedNarrower: z.boolean().optional(),
});
