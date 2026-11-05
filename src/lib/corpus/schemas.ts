/** Request bodies for /api/corpora (zod). */
import { z } from "zod";
import { BINDINGS, CORPUS_KINDS, CORPUS_STATUSES, MODALITIES, SEVERITIES, SOURCE_ROLES, scopeSchema } from "./pure";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}/, "Use a date like 2026-03-01.").nullish();

export const corpusBody = z.object({
  name: z.string().trim().min(1, "Give the corpus a name.").max(160),
  description: z.string().trim().max(2000).nullish(),
  kind: z.enum(CORPUS_KINDS).default("own_rules"),
  authority: z.string().trim().max(160).nullish(),
  binding: z.enum(BINDINGS).default("mandatory"),
  version: z.string().trim().max(80).nullish(),
  effectiveFrom: day,
  effectiveTo: day,
  status: z.enum(CORPUS_STATUSES).optional(),
  scope: scopeSchema.optional(),
  checkByDefault: z.boolean().optional(),
});

export const corpusPatch = corpusBody.partial();

export const sourcesBody = z.union([
  z.object({ sourceIds: z.array(z.string().uuid()).min(1, "Pick at least one document.").max(30), role: z.enum(SOURCE_ROLES).optional() }),
  z.object({ url: z.string().trim().min(4, "Type a web address.").max(1000), role: z.enum(SOURCE_ROLES).optional() }),
]);

export const readBody = z.object({ mode: z.enum(["read", "version"]).default("read"), version: z.string().trim().max(80).nullish() });

export const decideBody = z.union([
  z.object({ ids: z.array(z.string().uuid()).min(1).max(200), action: z.enum(["approve", "drop"]) }),
  /** Many at once: every rule read from the text itself, all, one chapter's, or the definitions. */
  z.object({ scope: z.enum(["text", "all", "definitions"]), action: z.enum(["approve", "drop"]) }),
  z.object({ scope: z.literal("chapter"), chapter: z.string().trim().min(1).max(300), action: z.enum(["approve", "drop"]) }),
]);

/** POST /api/corpora/from-link: one pasted address. */
export const fromLinkBody = z.object({ url: z.string().trim().min(4, "Paste a web address.").max(2000) });

/** POST /api/corpora/[id]/work: read the link again ("full") or check it for changes ("recheck"). */
export const workBody = z.object({ mode: z.enum(["full", "recheck"]).default("recheck") });

export const ruleBody = z.object({
  ref: z.string().trim().min(1, "Give the rule its reference, e.g. §16 stk. 2.").max(80),
  title: z.string().trim().max(160).optional(),
  text: z.string().trim().min(8, "Write the rule in a sentence.").max(800),
  modality: z.enum(MODALITIES),
  severity: z.enum(SEVERITIES).optional(),
  checkHint: z.string().trim().max(600).nullish(),
  quote: z.string().trim().max(1600).nullish(),
});

export const rulePatch = z.object({
  ref: z.string().trim().min(1).max(80).optional(),
  title: z.string().trim().max(160).optional(),
  text: z.string().trim().min(8).max(800).optional(),
  modality: z.enum(MODALITIES).optional(),
  severity: z.enum(SEVERITIES).optional(),
  checkHint: z.string().trim().max(600).nullish(),
  appliesTo: scopeSchema.optional(),
  status: z.enum(["active", "retired"]).optional(),
});
