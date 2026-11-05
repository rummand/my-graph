/**
 * Compliance for the assistant (server-only): the rules a question needs ("Does this comply with BEK 260?" gets the
 * corpus's rules with their references), and the check of an answer and its proposals once it is written.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { messages, type AssistantStep } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { activeRules, corporaNamed, searchRules, type ActiveRule } from "@/lib/corpus";
import { checkText, corporaFor, type CheckResult } from "./index";
import { loadTarget } from "./targets";

/** Words that make a question about rules, in English and Danish. */
const ASKS = /\b(compl(y|ies|iance|iant)|regulat\w*|legislat\w*|law|legal|rules?|governance|guardrails?|policy|policies|allowed|permitted|overhold\w*|lov\w*|regel\w*|regler|bekendtgørelse\w*|vejledning\w*|krav|tilladt|må vi|skal vi|konvention\w*)\b|§|\bADR\b|\bBEK\b/i;

export type RulesForQuestion = { hint: string | null; rules: ActiveRule[]; corpora: { id: string; name: string }[]; named: boolean };

/**
 * The rules that belong in the answer's context: every active rule of a corpus the question names (closest first,
 * at most 14), else the closest rules across the graph's corpora when the question is about rules or is close to one.
 * Returned as a prompt hint that asks for answers with references.
 */
export async function rulesForQuestion(v: Viewer, question: string): Promise<RulesForQuestion> {
  const named = await corporaNamed(v, question);
  let rules: ActiveRule[] = [];
  if (named.length) {
    rules = (await activeRules(v, named.map((c) => c.id), null)).slice(0, 14);
    const close = await searchRules(v, question, { corpusIds: named.map((c) => c.id), limit: 14 });
    const ids = new Set(close.map((r) => r.id));
    rules = [...close, ...rules.filter((r) => !ids.has(r.id))].slice(0, 14);
  } else {
    const asks = ASKS.test(question);
    const close = await searchRules(v, question, { limit: asks ? 8 : 4 });
    rules = asks ? close : close.filter((r) => r.score > 0.62);
  }
  if (!rules.length) return { hint: null, rules: [], corpora: named, named: named.length > 0 };
  const corpora = [...new Map(rules.map((r) => [r.corpusId, { id: r.corpusId, name: r.corpusName }])).values()];
  const lines = rules.map((r) => `- [${r.corpusName} ${r.ref}] (${r.modality.replace("_", " ")}) ${r.text}${r.quote ? ` Source text: "${r.quote.slice(0, 300)}"` : ""}`);
  const hint = [
    `Rules this graph follows (from its corpora: ${corpora.map((c) => c.name).join(", ")}). They were approved by people in the graph.`,
    ...lines,
    "When the question is whether something complies, or the answer touches one of these rules: say plainly whether it meets each relevant rule, name the rule by its corpus and reference (e.g. \"BEK 260 §16 stk. 2\"), quote the rule's words briefly, and say what would make it comply. Never claim compliance the context doesn't show; say what is unclear.",
  ].join("\n");
  return { hint, rules, corpora, named: named.length > 0 };
}

/** The step shown under the answer: "Checked against 2 corpora" (translated where it is shown). */
export function checkedStep(n: number): AssistantStep {
  return { kind: "other", label: `Checked against ${n} ${n === 1 ? "corpus" : "corpora"}`, count: n };
}

/**
 * Check a saved answer (its text and what it proposes) against the graph's corpora, then add the step to the
 * message. Runs after the answer is sent, so it never slows the answer down; the chat shows the result when it lands.
 */
export async function checkAnswer(v: Viewer, messageId: string, opts: { corpusIds?: string[] | null } = {}): Promise<CheckResult | null> {
  const t = await loadTarget(v, "message", messageId);
  if (!t.text.trim()) return null;
  const { picked } = await corporaFor(v, { targetType: "message" }, messageId, opts.corpusIds ?? null);
  if (!picked.length) return null;
  // affinity = the conversation: its answers are checked one after another against much the same rules (cached).
  const [m] = await db.select({ conversationId: messages.conversationId }).from(messages).where(eq(messages.id, messageId)).limit(1);
  const result = await checkText(v, {
    text: t.text, targetType: "message", targetId: messageId,
    context: { sensitive: t.sensitive, missing: false, corpusIds: opts.corpusIds ?? null, affinity: m ? `compliance:chat:${m.conversationId}` : null },
  });
  if (result.status !== "skipped" && result.status !== "unavailable") {
    const [row] = await db.select({ steps: messages.steps }).from(messages).where(eq(messages.id, messageId)).limit(1);
    const steps = (row?.steps ?? []).filter((s) => !/^Checked against \d+ corp/.test(s.label));
    await db.update(messages).set({ steps: [...steps, checkedStep(result.corpora.length)] }).where(and(eq(messages.id, messageId)));
  }
  return result;
}
