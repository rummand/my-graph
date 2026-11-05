/**
 * The watch's pure checks (no DB, no server imports; safe in the browser and in tests): clashes in time, contradictions
 * between sources, fulfilment evidence, at-risk and the morning line. The server side is ./index.ts.
 */
export { findClashes, explainClash, whenText, travelMinutes, pairKey, PRESENCE_WORDS, ADULT_WORDS, type Slot, type Clash, type ClashKind, type ClashOptions, type WatchLocale } from "./clash";
export { findContradictions, explainContradiction, classifySource, strongerOf, claimsOf, movedTo, SOURCE_RANK, type SourceClass, type Statement, type Claim, type Contradiction, type FieldValue } from "./contradict";
export { matchFulfilment, matchHappenedEvent, donePhrase, vetoed, mentionsCounterparty, inWindow, type FulfilCommitment, type Evidence, type FulfilMatch } from "./fulfil";
export { assessRisk, withSignal, type ProgressSignal, type RiskVerdict } from "./risk";
export { morningSummary, type SummaryItem, type SummaryLocale } from "./summary";
export { findAmounts, findPeriods, findDueDates, parseNumber, sameAmount } from "./text";
