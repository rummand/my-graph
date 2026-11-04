/** The answer given when no model can write one (pure, unit-tested). */
import type { TFn } from "@/lib/i18n/core";
import type { ContextItem, NumberedContext } from "./context";
import { joinAnd, tPure, voiceFor, type Voice } from "./voice";

export type DegradedReason = "unreachable" | "not_configured" | "rejected" | "error";

/** What to say when no model can answer: why, and what the brain has that matches (with citations). */
export function degradedAnswer(reason: DegradedReason, ctx: NumberedContext, items: ContextItem[], voice: Voice = voiceFor("family", "en")): string {
  const { t, noun } = voice;
  const why = t(`chat.server.degraded.${reason === "not_configured" ? "notConfigured" : reason}`);
  const best = items
    .map((it, i) => ({ it, n: i + 1 }))
    .filter(({ it }) => it.kind !== "reminder")
    .slice(0, 5);
  if (ctx.empty || !best.length) return `${why}\n\n${t("chat.server.degraded.nothing", { noun })}`;
  const lines = best.map(({ it, n }) => {
    if (it.kind === "passage") return `- **${it.title}**: "${clipText(it.text, 160)}" [${n}]`;
    if (it.kind === "fact") return `- ${it.title}${it.status !== "confirmed" ? ` (${t(`chat.server.status.${it.status}`, undefined, it.status)})` : ""} [${n}]`;
    if (it.kind === "node") return `- **${it.title}**${it.when ? ` · ${it.when}` : ""}${it.text ? `: ${clipText(it.text, 120)}` : ""} [${n}]`;
    return "";
  }).filter(Boolean);
  return `${why} ${t("chat.server.degraded.matches", { noun })}\n\n${lines.join("\n")}`;
}

const clipText = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** One plain sentence from an answer: the first sentence, without citation marks or markdown, at most ~200 chars. */
export function firstSentence(text: string, max = 200): string {
  const plain = text
    .replace(/\s?\[\d+(?:\s*[,;–-]\s*\d+)*\]/g, "")
    .replace(/[*_`#>]+/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return "";
  const m = /^(.+?[.!?])(\s|$)/.exec(plain);
  const s = (m ? m[1] : plain).trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** A run's summary when no model could write one: what was found, by kind (in the owner's language). */
export function deterministicSummary(items: ContextItem[], reason: DegradedReason | null, t: TFn = tPure("en")): string {
  const docs = new Set(items.filter((i) => i.kind === "passage").map((i) => (i as Extract<ContextItem, { kind: "passage" }>).sourceId)).size;
  const events = items.filter((i) => i.kind === "node" && i.nodeType === "event").length;
  const reminders = items.filter((i) => i.kind === "reminder").length;
  const parts: string[] = [];
  if (docs) parts.push(t("chat.server.summary.docs", { count: docs }));
  if (events) parts.push(t("chat.server.summary.events", { count: events }));
  if (reminders) parts.push(t("chat.server.summary.reminders", { count: reminders }));
  const found = parts.length ? t("chat.server.summary.found", { what: joinAnd(parts, t) }) : t("chat.server.summary.nothing");
  if (!reason) return `${found}.`;
  return t("chat.server.summary.noSummary", { found, why: t(reason === "not_configured" ? "chat.server.summary.notSetUp" : "chat.server.summary.unreachable") });
}
