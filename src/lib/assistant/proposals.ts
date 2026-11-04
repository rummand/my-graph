/**
 * Assistant actions (pure, unit-tested). The model may end an answer with
 *   <proposals>[{"type":"propose_reminder", …}, …]</proposals>
 * The block is never shown as text: it is parsed server-side into cards the user approves or dismisses.
 */
import { z } from "zod";

const str = (max: number) => z.string().trim().min(1).max(max);

const nodeType = z.enum(["person", "place", "event", "topic"]);

/**
 * What a proposal rests on: something the user said in this chat ("user"), or only outside content such as an
 * uploaded letter ("document"). Document-only proposals are never applied automatically.
 */
const basis = z.enum(["user", "document"]).nullish().catch(null).transform((v) => v ?? null);

export const reminderProposal = z.object({
  type: z.literal("propose_reminder"),
  title: str(200),
  /** ISO date or date-time. */
  dueAt: str(40).refine((s) => !Number.isNaN(Date.parse(s)), "dueAt must be a date"),
  aboutPerson: z.string().trim().max(120).nullish().transform((v) => v || null),
  detail: z.string().trim().max(1000).nullish().transform((v) => v || null),
  basis,
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
  basis,
});

export const wikiProposal = z.object({
  type: z.literal("propose_wiki_note"),
  title: str(150),
  text: str(20_000),
  basis,
});

/** Something to remember across conversations: a family rule, a preference or a note (Scout's memory). */
export const memoryProposal = z.object({
  type: z.literal("propose_memory"),
  kind: z.enum(["preference", "rule", "note"]).catch("note"),
  text: str(500),
  /** Names of the people/places it is about, as written in the context. */
  about: z.array(z.string().trim().min(1).max(120)).max(6).nullish().catch(null).transform((v) => v ?? []),
  /** The user's own words it was learned from. */
  quote: z.string().trim().max(500).nullish().transform((v) => v || null),
  basis,
});

export const proposalSchema = z.discriminatedUnion("type", [reminderProposal, factProposal, wikiProposal, memoryProposal]);
export type Proposal = z.infer<typeof proposalSchema>;

export type ProposalStatus = "pending" | "approved" | "dismissed" | "undone";

/** What approving created, and how to take it back. */
export type ProposalResult = { href?: string; label: string; undo?: { type: "reminder" | "edge" | "wiki" | "memory"; id: string } | null };

/** A proposal as shown in the UI: its number within the message, status, and what approving it created. */
export type ProposalView = Proposal & {
  n: number; status: ProposalStatus; result?: ProposalResult | null; error?: string | null;
  /** Applied without asking: "always" = the person chose Always allow, "setting" = auto-save memories is on. */
  auto?: "always" | "setting" | null;
  /** Shown on the card when approving would make conversation content visible to more people. */
  widens?: string | null;
  /** The current value this would change (shown as a diff), e.g. "Emma attends Lindevang School". */
  current?: string[] | null;
};

export const MAX_PROPOSALS = 4;
const OPEN = "<proposals>";
const CLOSE = "</proposals>";
/** Blocks at the end of an answer that are parsed, never shown as text. */
const HIDDEN_OPENS = ["<proposals>", "<clarify>"];

const ALIASES: Record<string, Proposal["type"]> = {
  propose_reminder: "propose_reminder", reminder: "propose_reminder",
  propose_fact: "propose_fact", fact: "propose_fact",
  propose_wiki_note: "propose_wiki_note", wiki_note: "propose_wiki_note", wiki: "propose_wiki_note", note: "propose_wiki_note",
  propose_memory: "propose_memory", memory: "propose_memory", remember: "propose_memory", propose_rule: "propose_memory", rule: "propose_memory",
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
    const hits = HIDDEN_OPENS.map((o) => this.pending.indexOf(o)).filter((i) => i >= 0);
    if (hits.length) {
      const at = Math.min(...hits);
      this.hidden = true;
      const out = this.pending.slice(0, at);
      this.pending = "";
      return out;
    }
    // Keep a tail that is a prefix of a block's opening tag.
    let keep = 0;
    const longest = Math.max(...HIDDEN_OPENS.map((o) => o.length));
    for (let k = Math.min(longest - 1, this.pending.length); k > 0; k--) {
      const tail = this.pending.slice(-k);
      if (HIDDEN_OPENS.some((o) => o.startsWith(tail))) { keep = k; break; }
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
    case "propose_memory": return `Remember: ${p.text}`;
  }
}
