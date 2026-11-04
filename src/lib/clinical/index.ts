/**
 * The clinical workspace (psychologists, therapists, doctors) in a practice graph. Gated by the plan features
 * "practice_psychology" and "practice_medical" (src/lib/plans): without them nothing clinical exists for an account.
 * Pure rules: ./pure (consent, access, risk flags, codes, labs, measures). Server-only from here on.
 */
export * from "./access";
export * from "./records";
export * from "./items";
export { startTranscription, startDraft, typedTranscript } from "./generate";
export * from "./pure";
