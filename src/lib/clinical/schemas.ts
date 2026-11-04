/** Request bodies for /api/clinical (zod). */
import { z } from "zod";
import { LETTER_KINDS, PURPOSES, type Purpose } from "./pure";

const date = z.coerce.date();
const text = (max: number) => z.string().trim().max(max);

export const createClientBody = z.object({
  name: text(120).min(1, "Enter a name."),
  discipline: z.enum(["psychology", "medical"]),
  reason: text(2000).nullish(),
});

export const consentBody = z.object({
  purposes: z.array(z.enum(PURPOSES as [Purpose, ...Purpose[]])).max(5),
  sharedWith: z.array(z.string().uuid()).max(50).default([]),
  signedAt: date,
  reviewAt: date.nullish().transform((d) => d ?? null),
  documentSourceId: z.string().uuid().nullish().transform((d) => d ?? null),
  note: text(2000).nullish().transform((s) => s || null),
});
export const consentPatch = z.object({
  purposes: z.array(z.enum(PURPOSES as [Purpose, ...Purpose[]])).max(5).optional(),
  sharedWith: z.array(z.string().uuid()).max(50).optional(),
  signedAt: date.optional(),
  reviewAt: date.nullish(),
  documentSourceId: z.string().uuid().nullish(),
  note: text(2000).nullish(),
});
export const withdrawBody = z.object({ note: text(2000).nullish().transform((s) => s || null) });
export const shareBody = z.object({ userId: z.string().uuid() });

export const sessionBody = z.object({ startsAt: date, title: text(200).nullish(), language: z.enum(["da", "en"]).default("da") });
export const measureBody = z.object({
  instrument: z.enum(["phq9", "gad7"]),
  answers: z.array(z.number().int().min(0).max(3)).min(7).max(9),
  takenAt: date.default(() => new Date()),
  sessionId: z.string().uuid().nullish(),
});
export const labsBody = z.object({ sourceId: z.string().uuid(), sessionId: z.string().uuid().nullish() });
export const letterBody = z.object({
  letterKind: z.enum(LETTER_KINDS), recipient: text(300).default(""), instructions: text(1000).nullish(),
  lang: z.enum(["da", "en"]).default("da"), sessionId: z.string().uuid().nullish(),
});
export const summaryBody = z.object({ lang: z.enum(["da", "en"]).default("da") });
export const followupBody = z.object({ title: text(200).min(1, "Say what to follow up."), dueAt: date, sessionId: z.string().uuid().nullish() });

export const transcriptBody = z.object({ text: text(200_000).min(1, "Paste or type the transcript.") });

export const itemPatch = z.object({
  content: z.record(z.string().max(40), z.unknown()).optional(),
  title: text(500).nullish(),
  value: z.number().finite().nullish(),
  unit: text(30).nullish(),
  measuredAt: date.nullish(),
  baseVersion: z.number().int().optional(),
});
export const decideBody = z.object({
  decision: z.enum(["sign", "confirm", "dismiss", "acknowledge", "reopen", "complete"]),
  content: z.record(z.string().max(40), z.unknown()).optional(),
  baseVersion: z.number().int().optional(),
});
