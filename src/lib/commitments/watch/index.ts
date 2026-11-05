/**
 * The commitments watch (server-only): connects the dots no single document shows and closes the loop — clashes in
 * time, contradictions between sources, proof that something is done, at-risk signals and the morning line. Everything
 * it finds is a proposal (change set with receipts) or an advisory flag; nothing is changed or ticked off silently.
 * Pure checks: ./pure.ts. See docs/commitments.md ("The watch").
 */
export * from "./pure";
export { contradictionFlags, progressSignals, withProgress, morningLine, type CommitmentFlag } from "./flags";
export { afterDelivery, afterSourceRead, checkClashes, checkSourceForFulfilment, checkCommitmentsAgainstRecent, proposeContradictionFixes, dailyWatch } from "./run";
export { startCommitmentWatch, stopCommitmentWatch } from "./scheduler";
