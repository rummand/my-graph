/**
 * Client-executed page actions (server-only): a chat turn that called a page action waits here until the browser
 * that asked posts the outcome to /api/chat/[id]/action. Keyed by a random call id and checked against the person
 * and conversation, so nobody else can answer for them. In-process, like the turn's stop switch.
 */
import type { ClientActionOutcome } from "./page-actions";

type Waiter = { userId: string; conversationId: string; resolve: (o: ClientActionOutcome) => void };

const g = globalThis as unknown as { __mgClientActions?: Map<string, Waiter> };
const waiters: Map<string, Waiter> = g.__mgClientActions ?? (g.__mgClientActions = new Map<string, Waiter>());

/** How long a turn waits: a read action answers at once; a change waits for the person to decide. */
export const WAIT_MS = { read: 30_000, change: 10 * 60_000 } as const;

export function awaitClientAction(
  key: { callId: string; userId: string; conversationId: string },
  opts: { timeoutMs: number; signal: AbortSignal; onTick?: () => void },
): Promise<ClientActionOutcome> {
  return new Promise<ClientActionOutcome>((resolve, reject) => {
    let tick: ReturnType<typeof setInterval> | undefined;
    const finish = (fn: () => void) => {
      clearTimeout(timer);
      clearInterval(tick);
      opts.signal.removeEventListener("abort", onAbort);
      waiters.delete(key.callId);
      fn();
    };
    const onAbort = () => finish(() => reject(new DOMException("stopped", "AbortError")));
    const timer = setTimeout(() => finish(() => resolve({ status: "unavailable", error: "Nobody answered in time (the window may have been closed)." })), opts.timeoutMs);
    if (opts.onTick) tick = setInterval(opts.onTick, 15_000);
    if (opts.signal.aborted) { onAbort(); return; }
    opts.signal.addEventListener("abort", onAbort, { once: true });
    waiters.set(key.callId, { userId: key.userId, conversationId: key.conversationId, resolve: (o: ClientActionOutcome) => finish(() => resolve(o)) });
  });
}

/** The browser's answer. False when no turn is waiting for this call from this person in this conversation. */
export function settleClientAction(key: { callId: string; userId: string; conversationId: string }, outcome: ClientActionOutcome): boolean {
  const w = waiters.get(key.callId);
  if (!w || w.userId !== key.userId || w.conversationId !== key.conversationId) return false;
  w.resolve(outcome);
  return true;
}
