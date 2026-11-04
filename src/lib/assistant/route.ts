/**
 * Which mux route answers a question (pure, unit-tested).
 *
 * mux's routes (mux/server/src/index.ts seed): `fast` = the fastest model that can do it (short answers,
 * classification), `smart` = "the best answer this Mac can give" (quality strategy), `agent` = reliable tool calls
 * first. The owner saw "Quick answer" on questions that needed thought, so `fast` is now kept for trivial things only:
 *
 * - `agent` when anything retrieved is sensitive (local models only, no cloud fallback) or when tools were used
 *   (web search / page reading: the answer is written from material the assistant fetched itself),
 * - `fast` only for greetings, thanks and one short lookup that the graph answers with a handful of items,
 * - `smart` for everything else: reasoning, planning, drafting, comparisons, modelling, anything that leans on the
 *   person's own context, follow-ups and multi-part questions.
 */
import type { MuxRoute } from "@/lib/mux";

const REASONING = [
  // English
  /\b(plan|planning|prepare|organi[sz]e|schedule|should (i|we)|what should|how (do|can|should|would|could) (i|we)|help me|draft|write|compare|comparison|pros and cons|trade-?offs?|decide|decision|why|explain|summari[sz]e|overview|suggest|advice|advise|recommend|budget|strategy|step[- ]by[- ]step|analy[sz]e|analysis|model|modell?ing|estimate|calculate|forecast|what if|implications?|think|reason|figure out|work out|options|evaluate|assess|review|improve|design|structure|prioriti[sz]e|risks?)\b/i,
  // Danish (Unicode word edges: \b doesn't see æ, ø and å as letters)
  /(?<![\p{L}\p{N}])(planl[æa]g\p{L}*|forbered\p{L}*|organiser\p{L}*|skal (jeg|vi)|hvad b[øo]r|hvordan (kan|skal|g[øo]r|ville|kunne)|hj[æa]lp mig|skriv\p{L}*|udkast|sammenlign\p{L}*|beslut\p{L}*|hvorfor|forklar\p{L}*|opsummer\p{L}*|overblik|foresl[åa]\p{L}*|r[åa]d|anbefal\p{L}*|budget|strategi|analys\p{L}*|model\p{L}*|beregn\p{L}*|vurder\p{L}*|hvad hvis|t[æa]nk\p{L}*|muligheder|prioriter\p{L}*|risiko|risici|forbedr\p{L}*)(?![\p{L}\p{N}])/iu,
];

const LOOKUP = /^(when|who|where|what|which|is|are|does|did|has|how (old|many|much)|hvorn[åa]r|hvem|hvor|hvad|hvilk\w*|er|har|var|hvor (gammel|mange|meget))\b/i;

const SMALL_TALK = /^(hi|hello|hey|thanks|thank you|thx|ok|okay|great|good morning|good night|hej|hejsa|tak|tusind tak|godmorgen|godnat|fint|super)[\s!.,]*$/i;

export type RouteOptions = {
  /** Anything in the context is sensitive: stay on local models. */
  sensitive?: boolean;
  /** The assistant used tools for this answer (web search, page reading). */
  tools?: boolean;
  /** How many items from the graph the answer is written from (more = the person's own context matters). */
  contextItems?: number;
  /** The conversation already has earlier turns (a follow-up leans on what was said). */
  followUp?: boolean;
};

/** Why a route was chosen, for logs and tests. */
export type RouteDecision = { route: MuxRoute; why: "sensitive" | "tools" | "small_talk" | "lookup" | "reasoning" | "long" | "context" | "follow_up" | "default" };

export function decideRoute(question: string, opts: RouteOptions = {}): RouteDecision {
  if (opts.sensitive) return { route: "agent", why: "sensitive" };
  if (opts.tools) return { route: "agent", why: "tools" };
  const q = question.replace(/@\[([^\]]+)\]\(node:[0-9a-f-]{36}\)/gi, "$1").trim();
  if (SMALL_TALK.test(q)) return { route: "fast", why: "small_talk" };
  if (REASONING.some((r) => r.test(q))) return { route: "smart", why: "reasoning" };
  const questions = (q.match(/\?/g) ?? []).length;
  const sentences = q.split(/[.!?]+\s/).filter((s) => s.trim()).length;
  if (q.length > 120 || questions > 1 || sentences > 1 || /\b(and|og) (also|then|ogs[åa]|s[åa])\b/i.test(q)) return { route: "smart", why: "long" };
  if (opts.followUp && !LOOKUP.test(q)) return { route: "smart", why: "follow_up" };
  if (LOOKUP.test(q) && q.length <= 80) {
    // A short lookup the graph answers from a few items; a lookup across lots of the person's context needs care.
    if ((opts.contextItems ?? 0) > 6) return { route: "smart", why: "context" };
    return { route: "fast", why: "lookup" };
  }
  return { route: "smart", why: "default" };
}

export function chooseRoute(question: string, opts: RouteOptions = {}): MuxRoute {
  return decideRoute(question, opts).route;
}
