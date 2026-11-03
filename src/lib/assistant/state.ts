/**
 * Conversation state kept as hidden `system` messages (pure). The messages table has no column for proposal
 * decisions or a conversation's sensitivity, so they are recorded as small JSON system messages that the UI and the
 * model never see. Append-only, like everything else: the latest decision for a proposal wins.
 */
import { z } from "zod";
import type { ProposalStatus } from "./proposals";

const PREFIX = "my-graph-state:";

export const stateSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("proposal"),
    messageId: z.string(),
    n: z.number().int().min(1),
    status: z.enum(["approved", "dismissed"]),
    result: z.object({ href: z.string().optional(), label: z.string() }).nullish(),
  }),
  /** Something sensitive was discussed: later turns stay on local models. */
  z.object({ type: z.literal("sensitive") }),
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

export type Decisions = Map<string, { status: Exclude<ProposalStatus, "pending">; result?: { href?: string; label: string } | null }>;

export const decisionKey = (messageId: string, n: number) => `${messageId}#${n}`;

/** Fold the state messages of a conversation (oldest first). */
export function foldState(contents: string[]): { decisions: Decisions; sensitive: boolean } {
  const decisions: Decisions = new Map();
  let sensitive = false;
  for (const c of contents) {
    const s = decodeState(c);
    if (!s) continue;
    if (s.type === "sensitive") sensitive = true;
    else decisions.set(decisionKey(s.messageId, s.n), { status: s.status, result: s.result ?? null });
  }
  return { decisions, sensitive };
}
