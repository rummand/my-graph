/**
 * "Compact this conversation" (pure, unit-tested): earlier turns are summarised into conversations.summary, and from
 * then on the summary is sent to the model instead of those turns. The turns stay visible in the thread.
 */
import type { MuxMessage } from "@/lib/mux";
import { citedTitles, earlierAnswer, plainMentions } from "./prompt";

export type Turn = { id: string; role: "user" | "assistant" | "system"; content: string; citations?: { title: string }[] | null };

/** Keep the last `keep` messages as they are; everything before is summarised. Null when there's too little to compact. */
export function compactSplit<T extends Turn>(rows: T[], keep = 4): { older: T[]; upTo: T } | null {
  const visible = rows.filter((r) => r.role !== "system");
  if (visible.length <= keep + 1) return null;
  const older = visible.slice(0, visible.length - keep);
  // End on an assistant answer so a question is never separated from its answer.
  while (older.length && older[older.length - 1].role !== "assistant") older.pop();
  if (older.length < 2) return null;
  return { older, upTo: older[older.length - 1] };
}

/**
 * Automatic compaction for long sessions: once more than `over` messages are sent in full, everything but the last
 * `keep` is summarised (cheap route). Between compactions the turns sent stay the same, so the prompt cache holds
 * them; a sliding window would change the first message every turn. Null when nothing needs doing yet.
 */
export function autoCompactSplit<T extends Turn>(rows: T[], opts: { over?: number; keep?: number } = {}): { older: T[]; upTo: T } | null {
  const over = opts.over ?? 16;
  const visible = rows.filter((r) => r.role !== "system");
  if (visible.length <= over) return null;
  return compactSplit(visible, opts.keep ?? 6);
}

/** The turns after the compaction point (the ones still sent in full). */
export function turnsAfter<T extends Turn>(rows: T[], upToId: string | null | undefined): T[] {
  if (!upToId) return rows;
  const i = rows.findIndex((r) => r.id === upToId);
  return i < 0 ? rows : rows.slice(i + 1);
}

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

function transcript(older: Turn[], previous: string | null): string {
  const lines = older.map((t) => {
    if (t.role !== "assistant") return `Question: ${clip(plainMentions(t.content), 1500)}`;
    const titles = citedTitles(t.citations ?? []);
    const text = earlierAnswer(t.content).replace(/\s?\[(\d+(?:\s*(?:[,;]|[-–])\s*\d+)*)\]/g, "");
    return `Answer: ${clip(text, 1500)}${titles.length ? ` (Sources: ${titles.join("; ")})` : ""}`;
  });
  return [previous ? `Earlier summary: ${previous}` : "", ...lines].filter(Boolean).join("\n\n").slice(0, 24_000);
}

export function compactMessages(older: Turn[], previous: string | null): MuxMessage[] {
  return [
    {
      role: "system",
      content: "Summarise this conversation between a person and their assistant in My Graph so it can continue without the full text. Keep every concrete fact, date, name, decision and open question, and for facts from a document or record, its title in brackets (from the answers' Sources lines). Write 3 to 10 short bullet points starting with \"- \", in the language of the conversation. Reply with the bullets only.",
    },
    { role: "user", content: transcript(older, previous) },
  ];
}

/** When no model can summarise: the questions asked, in order. */
export function fallbackSummary(older: Turn[], previous: string | null): string {
  const qs = older.filter((t) => t.role === "user").map((t) => `- Asked: ${clip(t.content, 160)}`);
  return [previous ?? "", ...qs].filter(Boolean).join("\n");
}

/** Tidy a model-written summary (strip reasoning tags, bound its length). */
export function cleanSummary(raw: string): string {
  return raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim().slice(0, 4000);
}
