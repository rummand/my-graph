/** The answer given when no model can write one (pure, unit-tested). */
import type { ContextItem, NumberedContext } from "./context";

export type DegradedReason = "unreachable" | "not_configured" | "rejected" | "error";

/** What to say when no model can answer: why, and what the brain has that matches (with citations). */
export function degradedAnswer(reason: DegradedReason, ctx: NumberedContext, items: ContextItem[]): string {
  const why = reason === "not_configured"
    ? "I can't write an answer right now because the model gateway (mux) isn't set up yet: MUX_API_KEY is missing."
    : reason === "rejected"
      ? "I can't write an answer right now because the model gateway (mux) refused My Graph's API key."
    : reason === "unreachable"
      ? "I can't reach the model gateway (mux) right now, so I can't write an answer."
      : "Something went wrong while writing the answer.";
  const best = items
    .map((it, i) => ({ it, n: i + 1 }))
    .filter(({ it }) => it.kind !== "reminder")
    .slice(0, 5);
  if (ctx.empty || !best.length) return `${why}\n\nI also couldn't find anything in your family brain that matches the question.`;
  const lines = best.map(({ it, n }) => {
    if (it.kind === "passage") return `- **${it.title}**: "${clipText(it.text, 160)}" [${n}]`;
    if (it.kind === "fact") return `- ${it.title}${it.status !== "confirmed" ? ` (${it.status})` : ""} [${n}]`;
    if (it.kind === "node") return `- **${it.title}**${it.when ? ` · ${it.when}` : ""}${it.text ? `: ${clipText(it.text, 120)}` : ""} [${n}]`;
    return "";
  }).filter(Boolean);
  return `${why} Here is what your family brain has that matches your question:\n\n${lines.join("\n")}`;
}

const clipText = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
