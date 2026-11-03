/**
 * Assistant actions (pure, unit-tested). The model may end an answer with
 *   <proposals>[{"type":"propose_reminder", …}, …]</proposals>
 * The block is never shown as text: it is parsed server-side into cards the user approves or dismisses.
 */
import { z } from "zod";

const str = (max: number) => z.string().trim().min(1).max(max);

const nodeType = z.enum(["person", "place", "event", "topic"]);

export const reminderProposal = z.object({
  type: z.literal("propose_reminder"),
  title: str(200),
  /** ISO date or date-time. */
  dueAt: str(40).refine((s) => !Number.isNaN(Date.parse(s)), "dueAt must be a date"),
  aboutPerson: z.string().trim().max(120).nullish().transform((v) => v || null),
  detail: z.string().trim().max(1000).nullish().transform((v) => v || null),
});

export const factProposal = z.object({
  type: z.literal("propose_fact"),
  from: str(120),
  relation: str(60).transform((r) => r.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")).refine((r) => r.length > 0, "relation is empty"),
  to: str(120),
  /** Node types to use if `from` / `to` aren't in the graph yet (they are then created). */
  fromType: nodeType.nullish().catch(null).transform((v) => v ?? null),
  toType: nodeType.nullish().catch(null).transform((v) => v ?? null),
  /** The sentence in the conversation the fact comes from. */
  quote: z.string().trim().max(500).nullish().transform((v) => v || null),
});

export const wikiProposal = z.object({
  type: z.literal("propose_wiki_note"),
  title: str(150),
  text: str(20_000),
});

export const proposalSchema = z.discriminatedUnion("type", [reminderProposal, factProposal, wikiProposal]);
export type Proposal = z.infer<typeof proposalSchema>;

export type ProposalStatus = "pending" | "approved" | "dismissed";

/** A proposal as shown in the UI: its number within the message, status, and what approving it created. */
export type ProposalView = Proposal & { n: number; status: ProposalStatus; result?: { href?: string; label: string } | null; error?: string | null };

export const MAX_PROPOSALS = 3;
const OPEN = "<proposals>";
const CLOSE = "</proposals>";

const ALIASES: Record<string, Proposal["type"]> = {
  propose_reminder: "propose_reminder", reminder: "propose_reminder",
  propose_fact: "propose_fact", fact: "propose_fact",
  propose_wiki_note: "propose_wiki_note", wiki_note: "propose_wiki_note", wiki: "propose_wiki_note", note: "propose_wiki_note",
};

/** Split an answer into the visible text and the proposals it carries (invalid ones are dropped). */
export function parseProposals(raw: string): { text: string; proposals: Proposal[] } {
  const start = raw.indexOf(OPEN);
  if (start < 0) return { text: raw.trim(), proposals: [] };
  const end = raw.indexOf(CLOSE, start);
  const inner = raw.slice(start + OPEN.length, end < 0 ? undefined : end);
  const text = (raw.slice(0, start) + (end < 0 ? "" : raw.slice(end + CLOSE.length))).trim();
  let parsed: unknown;
  try {
    const body = inner.replace(/```(?:json)?/gi, "").trim();
    parsed = JSON.parse(body);
  } catch {
    return { text, proposals: [] };
  }
  const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && Array.isArray((parsed as { proposals?: unknown }).proposals) ? (parsed as { proposals: unknown[] }).proposals : [parsed];
  const proposals: Proposal[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const rawType = String((item as { type?: unknown }).type ?? "");
    const type = ALIASES[rawType];
    if (!type) continue;
    const r = proposalSchema.safeParse({ ...item, type });
    if (r.success) proposals.push(r.data);
    if (proposals.length >= MAX_PROPOSALS) break;
  }
  return { text, proposals };
}

/**
 * Streaming filter: passes text through until the proposals block starts, and holds back anything that could be the
 * beginning of `<proposals>` so the user never sees the block flash by.
 */
export class ProposalStreamFilter {
  private pending = "";
  private hidden = false;

  push(delta: string): string {
    if (this.hidden) return "";
    this.pending += delta;
    const at = this.pending.indexOf(OPEN);
    if (at >= 0) {
      this.hidden = true;
      const out = this.pending.slice(0, at);
      this.pending = "";
      return out;
    }
    // Keep a tail that is a prefix of OPEN.
    let keep = 0;
    for (let k = Math.min(OPEN.length - 1, this.pending.length); k > 0; k--) {
      if (OPEN.startsWith(this.pending.slice(-k))) { keep = k; break; }
    }
    const out = this.pending.slice(0, this.pending.length - keep);
    this.pending = this.pending.slice(this.pending.length - keep);
    return out;
  }

  /** End of stream: release a held-back tail that turned out not to be a block. */
  flush(): string {
    const out = this.hidden ? "" : this.pending;
    this.pending = "";
    return out;
  }
}

/** Short human description of a proposal, for cards and audit entries. */
export function describeProposal(p: Proposal): string {
  switch (p.type) {
    case "propose_reminder": return `Reminder: ${p.title}`;
    case "propose_fact": return `Fact: ${p.from} ${p.relation.replace(/_/g, " ")} ${p.to}`;
    case "propose_wiki_note": return `Wiki note: ${p.title}`;
  }
}
