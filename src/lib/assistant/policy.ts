/**
 * What the assistant may do on its own (pure, unit-tested). Agents propose, humans decide:
 *  - Nothing in the graph is written without approval, unless the person chose "Always allow" for that kind of action.
 *  - Memory is the exception: the Brain Keeper curates it (src/lib/keeper). A memory the chat proposes goes to the
 *    keeper's inbox for its next run, without asking; when the person explicitly asked to remember something
 *    ("remember that …", "husk at …") it is saved at once.
 *  - Proposals that rest only on outside content (an uploaded letter, a web page) always ask.
 *  - Proposals that would make chat content visible to more people always ask.
 *  - Unattended runs (automations, heartbeat) never apply anything: every write becomes a suggestion.
 */
import type { SuggestionKind } from "@/lib/automations";
import type { TFn } from "@/lib/i18n/core";
import type { Proposal } from "./proposals";
import { tPure } from "./voice";

const EN: TFn = tPure("en");

export type ActionKind = "reminder.create" | "fact.create" | "wiki.create" | "memory.save";

export function actionKindOf(p: Proposal): ActionKind {
  switch (p.type) {
    case "propose_reminder": return "reminder.create";
    case "propose_fact": return "fact.create";
    case "propose_wiki_note": return "wiki.create";
    case "propose_memory": return "memory.save";
  }
}

export function suggestionKindOf(p: Proposal): SuggestionKind {
  switch (p.type) {
    case "propose_reminder": return "reminder";
    case "propose_fact": return "fact";
    case "propose_wiki_note": return "wiki_edit";
    case "propose_memory": return p.kind === "rule" ? "rule" : "memory";
  }
}

/** The capability in Assistant settings that a proposal needs. */
export function capabilityOf(p: Proposal): string | null {
  if (p.type === "propose_reminder") return "reminders";
  if (p.type === "propose_wiki_note") return "wiki_write";
  return null;
}

/** "Always allow new reminders" — the label on the approval card. */
export function alwaysLabelOf(p: Proposal): string {
  switch (p.type) {
    case "propose_reminder": return "Always allow reminders";
    case "propose_fact": return "Always allow suggested facts";
    case "propose_wiki_note": return "Always allow new wiki pages";
    case "propose_memory": return "Always save what I tell it";
  }
}

const words = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3);

/**
 * Did the user say this? True when `quote` appears in `text` (ignoring case and spacing), or at least 70% of its
 * meaningful words do.
 */
export function quoteInText(quote: string | null | undefined, text: string): boolean {
  if (!quote) return false;
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/[“”«»"]/g, "").trim();
  const q = norm(quote);
  if (q.length >= 4 && norm(text).includes(q)) return true;
  const qw = words(quote);
  if (qw.length < 2) return false;
  const tw = new Set(words(text));
  const hit = qw.filter((w) => tw.has(w)).length;
  return hit / qw.length >= 0.7;
}

const WRITE_ASK = /\b(remind|reminder|add|save|create|put|note down|write|log|record|schedule|book|remember|husk|tilføj|gem|opret|skriv|noter|påmind)/i;

/** The user explicitly asked for something to be written down or added. */
export function asksForWrite(userText: string): boolean {
  return WRITE_ASK.test(userText);
}

/** At least half of the meaningful words in `saved` appear in what the user wrote. */
export function mostlySaid(saved: string, userText: string): boolean {
  const sw = words(saved);
  if (!sw.length) return false;
  const tw = new Set(words(userText));
  return sw.filter((w) => tw.has(w)).length / sw.length >= 0.5;
}

/** The words a proposal rests on, to check against what the user said. */
export function proposalEvidence(p: Proposal): string {
  switch (p.type) {
    case "propose_reminder": return p.title;
    case "propose_fact": return p.quote ?? `${p.from} ${p.to}`;
    case "propose_wiki_note": return p.title;
    case "propose_memory": return p.quote ?? p.text;
  }
}

/**
 * What a proposal rests on. The model's own `basis` is trusted only when it says "document". Otherwise a proposal
 * counts as the user's when its evidence is in their words, and as outside content when the answer cited only
 * documents and the user never said it.
 */
export function inferBasis(p: Proposal, ctx: { userText: string; citedOnlyDocuments: boolean; citedDocuments?: boolean }): "user" | "document" {
  if (p.basis === "document") return "document";
  if (p.type === "propose_memory") {
    // A memory must come from the user's own words: the quote AND what would be saved. A model steered by a
    // document could otherwise pair a real quote ("who picks up Emma") with text the user never said.
    return quoteInText(proposalEvidence(p), ctx.userText) && mostlySaid(p.text, ctx.userText) ? "user" : "document";
  }
  if (quoteInText(proposalEvidence(p), ctx.userText)) {
    // Naming the topic ("what does the swim letter say about Emma's training?") isn't asking for a write. When the
    // answer leaned on a document, only an explicit request ("remind me…", "add…") makes it the user's.
    return ctx.citedDocuments && !asksForWrite(ctx.userText) ? "document" : "user";
  }
  return ctx.citedOnlyDocuments ? "document" : "user";
}

const REMEMBER_ASK = /\b(remember|don'?t forget|do not forget|keep in mind|make a note|note that|save (this|that)|husk|glem ikke|læg mærke til|noter|gem (det|dette))\b/i;

/** The person explicitly asked the assistant to remember something in this message. */
export function asksToRemember(question: string): boolean {
  // "Do you remember …?" is a question about memory, not a request to keep something.
  if (/\b(do|did|can|could) you (still )?remember\b|\bhusker du\b/i.test(question)) return false;
  return REMEMBER_ASK.test(question);
}

export type AutoDecision =
  | { mode: "ask"; why?: string }
  | { mode: "auto"; reason: "always" | "setting" | "asked" }
  /** Memory only: handed to the Brain Keeper for its next run. */
  | { mode: "keeper"; why: string };

export function autoApplyDecision(p: Proposal, ctx: {
  mode: "interactive" | "unattended";
  canWrite: boolean;
  alwaysAllow: string[];
  /** No longer decides memories (the Brain Keeper does); kept so older callers still type-check. */
  autoSaveMemories: boolean;
  basis: "user" | "document";
  /** The person's message in this turn (for "remember that …"). */
  question?: string;
  widens: boolean;
  capabilities: Record<string, boolean>;
}): AutoDecision {
  if (ctx.mode === "unattended") return { mode: "ask", why: "Nobody is watching: it only proposes." };
  if (!ctx.canWrite) return { mode: "ask", why: "You can't add to this graph." };
  if (p.type === "propose_memory") {
    // The person said "remember …" and it is their own words: keep it now, no wider than the chat.
    if (ctx.basis === "user" && !ctx.widens && asksToRemember(ctx.question ?? "")) return { mode: "auto", reason: "asked" };
    return {
      mode: "keeper",
      why: ctx.basis === "document" ? "It rests on outside content, so the Brain Keeper keeps it waiting for you."
        : "The Brain Keeper decides on its next run whether this is worth keeping.",
    };
  }
  const cap = capabilityOf(p);
  if (cap && ctx.capabilities[cap] === false) return { mode: "ask", why: "That's turned off in Assistant settings." };
  if (ctx.basis === "document") return { mode: "ask", why: "It rests only on outside content." };
  if (ctx.widens) return { mode: "ask", why: "It would make private content more widely visible." };
  if (ctx.alwaysAllow.includes(actionKindOf(p))) return { mode: "auto", reason: "always" };
  return { mode: "ask" };
}

/** Same suggestion → same key, so a denied one is never proposed again. */
export function dedupeKeyFor(p: Proposal): string {
  const n = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  switch (p.type) {
    case "propose_reminder": return `reminder:${n(p.title)}:${p.dueAt.slice(0, 10)}`;
    case "propose_fact": return `fact:${n(p.from)}:${p.relation}:${n(p.to)}`;
    case "propose_wiki_note": return `wiki:${n(p.title)}`;
    case "propose_memory": return `memory:${p.kind}:${n(p.text)}`;
  }
}

export type PlannedSuggestion = {
  proposal: Proposal; kind: SuggestionKind; title: string; body: string | null; payload: Record<string, unknown>; dedupeKey: string;
};

/** "Reminder: Pack swimming gear", in the reader's language (for skipped lines and audit text). */
export function describeProposalIn(p: Proposal, t: TFn = EN): string {
  switch (p.type) {
    case "propose_reminder": return t("chat.server.describe.reminder", { title: p.title });
    case "propose_fact": return t("chat.server.describe.fact", { from: p.from, relation: p.relation.replace(/_/g, " "), to: p.to });
    case "propose_wiki_note": return t("chat.server.describe.wiki", { title: p.title });
    case "propose_memory": return t("chat.server.describe.memory", { text: p.text });
  }
}

/** The suggestion title people see in the inbox, in the owner's language ("family rule" only in a family graph). */
export function suggestionTitle(p: Proposal, t: TFn = EN, family = false): string {
  switch (p.type) {
    case "propose_reminder": return t("chat.server.suggestion.reminder", { title: p.title });
    case "propose_fact": return t("chat.server.suggestion.fact", { from: p.from, relation: p.relation.replace(/_/g, " "), to: p.to });
    case "propose_wiki_note": return t("chat.server.suggestion.wiki", { title: p.title });
    case "propose_memory": return p.kind === "rule"
      ? t(family ? "chat.server.suggestion.ruleFamily" : "chat.server.suggestion.rule", { text: p.text })
      : t("chat.server.suggestion.memory", { text: p.text });
  }
}

/**
 * Scout's policy when nobody is watching: every write-like proposal becomes a suggestion (never applied); ones whose
 * capability is turned off are skipped. Returns the suggestions to file and the steps it could not even suggest.
 */
export function planUnattended(proposals: Proposal[], opts: { capabilities: Record<string, boolean>; memoryAllowed: boolean; t?: TFn; family?: boolean }): { suggest: PlannedSuggestion[]; skipped: string[] } {
  const t = opts.t ?? EN;
  const suggest: PlannedSuggestion[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const p of proposals) {
    const what = describeProposalIn(p, t);
    const cap = capabilityOf(p);
    if (cap && opts.capabilities[cap] === false) { skipped.push(t(cap === "reminders" ? "chat.server.skipped.remindersOff" : "chat.server.skipped.wikiOff", { what })); continue; }
    if (p.type === "propose_memory" && !opts.memoryAllowed) { skipped.push(t("chat.server.skipped.noMemory", { what })); continue; }
    const dedupeKey = dedupeKeyFor(p);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const payload = suggestionPayload(p);
    suggest.push({
      proposal: p, kind: suggestionKindOf(p), title: suggestionTitle(p, t, opts.family).slice(0, 250),
      body: p.type === "propose_wiki_note" ? p.text.slice(0, 2000) : p.type === "propose_reminder" ? p.detail : null,
      payload, dedupeKey,
    });
  }
  return { suggest, skipped };
}

/**
 * The payload a suggestion carries, in the shape the suggestions inbox applies (src/lib/automations policy schemas):
 * reminder {title, dueAt, detail}, fact {from/to {label, type}, relation, quote}, memory {text, kind, quote},
 * wiki_edit {title, text}. Names are resolved to ids later where possible (aboutNodeId, fromId/toId, aboutNodeIds).
 * `action` and `basis` ride along; unattended content counts as outside content, so a memory from it is never saved
 * without a person approving.
 */
export function suggestionPayload(p: Proposal): Record<string, unknown> {
  const extra = { action: actionKindOf(p), basis: p.basis ?? "document" };
  switch (p.type) {
    case "propose_reminder": return { title: p.title, dueAt: p.dueAt, detail: p.detail, aboutPerson: p.aboutPerson, ...extra };
    case "propose_fact": return {
      from: { label: p.from, type: p.fromType ?? "person" }, to: { label: p.to, type: p.toType ?? "topic" }, relation: p.relation, quote: p.quote, ...extra,
    };
    case "propose_wiki_note": return { title: p.title, text: p.text, ...extra };
    case "propose_memory": return { text: p.text, kind: p.kind, quote: p.quote, about: p.about, ...extra };
  }
}

/** The skipped-step line for a proposal that was turned into a suggestion (or couldn't be). */
export function skippedLine(p: Proposal, filed: boolean, t: TFn = EN): string {
  return t(filed ? "chat.server.skipped.waiting" : "chat.server.skipped.notFiled", { what: describeProposalIn(p, t) });
}

/** Suggestions store origin: a recipe run by an automation is the automation's; one run by hand counts as chat. */
export function suggestionOrigin(origin: "automation" | "heartbeat" | "recipe", runId?: string): "automation" | "heartbeat" | "chat" {
  if (origin === "heartbeat") return "heartbeat";
  if (origin === "automation") return "automation";
  return runId ? "automation" : "chat";
}
