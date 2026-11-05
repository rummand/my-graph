/**
 * The push tick (server-only), started by the automations scheduler: every minute, when push is on, it gathers what
 * is due (./collect) and delivers each item (./send). Never throws; every error is logged and the next tick goes on.
 */
import { clinicalRiskFlags, connectionsNeedingYou, dueReminders, waitingBatches, type Candidate } from "./collect";
import { pushSender } from "./config";
import { deliverPush } from "./send";
import { pruneDeliveries } from "./store";

type State = { ticking: boolean; timer?: ReturnType<typeof setInterval>; lastPrune?: number };
const g = globalThis as unknown as { __mgPushTick?: State };
const state: State = g.__mgPushTick ?? (g.__mgPushTick = { ticking: false });

export async function pushTick(): Promise<{ sent: number; considered: number }> {
  const sender = pushSender();
  if (!sender || state.ticking) return { sent: 0, considered: 0 };
  state.ticking = true;
  let sent = 0, considered = 0;
  try {
    const lists = await Promise.allSettled([dueReminders(), clinicalRiskFlags(), connectionsNeedingYou(), waitingBatches()]);
    const all: Candidate[] = [];
    for (const l of lists) {
      if (l.status === "fulfilled") all.push(...l.value);
      else console.error("[push] gathering failed:", l.reason instanceof Error ? l.reason.message : l.reason);
    }
    for (const c of all) {
      considered++;
      try {
        const r = await deliverPush(sender, c.userId, c.item, c.key);
        if (r.sent) sent++;
      } catch (err) {
        console.error("[push] delivery failed:", err instanceof Error ? err.message : err);
      }
    }
    if (!state.lastPrune || Date.now() - state.lastPrune > 24 * 3600_000) {
      state.lastPrune = Date.now();
      await pruneDeliveries().catch(() => {});
    }
  } finally {
    state.ticking = false;
  }
  return { sent, considered };
}

/** Starts the minute timer once per process. Logs once (via pushSender) when push is off, and then stays idle. */
export function startPushTicker(): void {
  if (state.timer || process.env.DISABLE_SCHEDULER === "1") return;
  if (!pushSender()) return;
  state.timer = setInterval(() => { void pushTick().catch(() => {}); }, 60_000);
  (state.timer as { unref?: () => void }).unref?.();
  setTimeout(() => { void pushTick().catch(() => {}); }, 15_000).unref?.();
}
