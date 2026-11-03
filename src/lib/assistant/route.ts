/** Which mux route answers a question (pure). */
import type { MuxRoute } from "@/lib/mux";

const REASONING = [
  // English
  /\b(plan|planning|prepare|organi[sz]e|schedule|should (i|we)|what should|how (do|can|should) (i|we)|help me|draft|write|compare|pros and cons|decide|decision|why|explain|summari[sz]e|overview|suggest|advice|budget|strategy|step[- ]by[- ]step)\b/i,
  // Danish
  /\b(planl[æa]g|forbered|organiser|skal (jeg|vi)|hvad b[øo]r|hvordan (kan|skal|g[øo]r)|hj[æa]lp mig|skriv|udkast|sammenlign|beslut|hvorfor|forklar|opsummer|overblik|foresl[åa]|r[åa]d|budget)\b/i,
];

const LOOKUP = /^(when|who|where|what|which|is|are|does|did|has|hvorn[åa]r|hvem|hvor|hvad|hvilk\w*|er|har|var)\b/i;

/**
 * - `agent` when anything retrieved is sensitive (local models only),
 * - `smart` for planning, drafting, reasoning or long multi-part questions,
 * - `fast` for short lookups.
 */
export function chooseRoute(question: string, opts: { sensitive?: boolean } = {}): MuxRoute {
  if (opts.sensitive) return "agent";
  const q = question.trim();
  if (REASONING.some((r) => r.test(q))) return "smart";
  const questions = (q.match(/\?/g) ?? []).length;
  const sentences = q.split(/[.!?]+\s/).filter((s) => s.trim()).length;
  if (q.length > 160 || questions > 1 || sentences > 2) return "smart";
  if (LOOKUP.test(q) || q.length <= 80) return "fast";
  return "smart";
}
