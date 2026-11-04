/**
 * Living profiles (server). Pages for people and any node: sections from the node's kind, facts as blocks with
 * provenance, agents' proposals inline with Deliver/Drop, a versioned written doc, and — for people, on plans with
 * "insights" — a private "How they've been doing" for the viewer. Pure parts: ./sections, ./doc, ./presets,
 * ./insights-pure, ./insights-gate.
 */
export { loadProfile, metaLike } from "./data";
export { addFact, type AddFactResult } from "./facts";
export { readDoc, saveDoc, listVersions, getVersion, proposeRestore, decideProposal, readableNode, mayWrite, ProfileError } from "./store";
export { readInsights, generateInsights, clearInsights } from "./insights";
export * from "./types";
