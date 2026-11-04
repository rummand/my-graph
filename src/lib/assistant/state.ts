/**
 * Conversation state kept as hidden `system` messages (pure). The messages table has no column for proposal
 * decisions or a conversation's sensitivity, so they are recorded as small JSON system messages that the UI and the
 * model never see. Append-only, like everything else: the latest decision for a proposal wins.
 */
import { z } from "zod";
import type { ProposalResult, ProposalStatus } from "./proposals";

const PREFIX = "my-graph-state:";

export const stateSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("proposal"),
    messageId: z.string(),
    n: z.number().int().min(1),
    status: z.enum(["approved", "dismissed", "undone"]),
    result: z.object({
      href: z.string().optional(), label: z.string(),
      undo: z.object({ type: z.enum(["reminder", "edge", "wiki", "memory"]), id: z.string() }).nullish(),
    }).nullish(),
    /** Applied without asking (always allow, or auto-save memories). */
    auto: z.enum(["always", "setting"]).nullish(),
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

export type Decision = { status: Exclude<ProposalStatus, "pending">; result?: ProposalResult | null; auto?: "always" | "setting" | null };
export type Decisions = Map<string, Decision>;

export const decisionKey = (messageId: string, n: number) => `${messageId}#${n}`;

/** Fold the state messages of a conversation (oldest first). */
export function foldState(contents: string[]): { decisions: Decisions; sensitive: boolean } {
  const decisions: Decisions = new Map();
  let sensitive = false;
  for (const c of contents) {
    const s = decodeState(c);
    if (!s) continue;
    if (s.type === "sensitive") sensitive = true;
    else {
      const key = decisionKey(s.messageId, s.n);
      // An undo keeps what was created (for the label) but the latest status wins.
      const prev = decisions.get(key);
      decisions.set(key, { status: s.status, result: s.result ?? prev?.result ?? null, auto: s.auto ?? prev?.auto ?? null });
    }
  }
  return { decisions, sensitive };
}
