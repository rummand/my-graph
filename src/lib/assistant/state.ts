/**
 * Conversation state kept as hidden `system` messages (pure). The messages table has no column for proposal
 * decisions or a conversation's sensitivity, so they are recorded as small JSON system messages that the UI and the
 * model never see. Append-only, like everything else: the latest decision for a proposal wins.
 */
import { z } from "zod";
import type { ProposalAuto, ProposalResult, ProposalStatus } from "./proposals";

const PREFIX = "my-graph-state:";

export const stateSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("proposal"),
    messageId: z.string(),
    n: z.number().int().min(1),
    status: z.enum(["queued", "approved", "dismissed", "undone"]),
    result: z.object({
      href: z.string().optional(), label: z.string(),
      undo: z.object({ type: z.enum(["reminder", "edge", "wiki", "memory"]), id: z.string() }).nullish(),
    }).nullish(),
    /** Applied without asking (always allow, auto-save memories, asked to remember, or the Brain Keeper's run). */
    auto: z.enum(["always", "setting", "asked", "keeper"]).nullish(),
    /** The Brain Keeper's one-line reason when it kept or declined a queued memory. */
    why: z.string().max(400).nullish(),
  }),
  /** Something sensitive was discussed: later turns stay on local models. */
  z.object({ type: z.literal("sensitive") }),
  /** Tools at connected MCP servers that an answer prepared and that wait for the person's approval (cards). */
  z.object({
    type: z.literal("mcp"),
    messageId: z.string(),
    approvals: z.array(z.object({
      token: z.string().max(4000), connectionId: z.string(), connection: z.string(), server: z.string().nullable(), tool: z.string(),
      title: z.string().nullable(), description: z.string().nullable(), args: z.record(z.string(), z.unknown()), expiresAt: z.string(),
    })).max(10),
  }),
]);
export type ConversationState = z.infer<typeof stateSchema>;

export function encodeState(s: ConversationState): string {
  return PREFIX + JSON.stringify(s);
}

export function decodeState(content: string): ConversationState | null {
  if (!content.startsWith(PREFIX)) return null;
  try {
    const r = stateSchema.safeParse(JSON.parse(content.slice(PREFIX.length)));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export type Decision = { status: Exclude<ProposalStatus, "pending">; result?: ProposalResult | null; auto?: ProposalAuto | null; why?: string | null };
export type Decisions = Map<string, Decision>;

export const decisionKey = (messageId: string, n: number) => `${messageId}#${n}`;

/** Fold the state messages of a conversation (oldest first). */
export type McpApprovals = Map<string, Extract<ConversationState, { type: "mcp" }>["approvals"]>;

export function foldState(contents: string[]): { decisions: Decisions; sensitive: boolean; mcp: McpApprovals } {
  const decisions: Decisions = new Map();
  const mcp: McpApprovals = new Map();
  let sensitive = false;
  for (const c of contents) {
    const s = decodeState(c);
    if (!s) continue;
    if (s.type === "sensitive") sensitive = true;
    else if (s.type === "mcp") mcp.set(s.messageId, [...(mcp.get(s.messageId) ?? []), ...s.approvals]);
    else {
      const key = decisionKey(s.messageId, s.n);
      // An undo keeps what was created (for the label) but the latest status wins.
      const prev = decisions.get(key);
      const why = s.why ?? prev?.why;
      decisions.set(key, { status: s.status, result: s.result ?? prev?.result ?? null, auto: s.auto ?? prev?.auto ?? null, ...(why ? { why } : {}) });
    }
  }
  return { decisions, sensitive, mcp };
}
