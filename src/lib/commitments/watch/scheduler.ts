/**
 * The daily watch (server-only): once a day after 06:00 Copenhagen time, every graph with open commitments gets
 * `dailyWatch` (clashes, appointments that happened, late proof, contradiction fixes). Checked hourly; the day it last
 * ran is kept in memory, and every finding has a stable key, so a restart or a second instance never proposes twice
 * (a second instance at worst repeats the reading). `DISABLE_SCHEDULER=1` turns it off with the rest.
 */
import { dayIn } from "./text";

type State = { timer?: ReturnType<typeof setInterval>; lastDay?: string; running: boolean; started: boolean };
const g = globalThis as unknown as { __mgCommitmentWatch?: State };
const state: State = g.__mgCommitmentWatch ?? (g.__mgCommitmentWatch = { running: false, started: false });
const TZ = "Europe/Copenhagen";

export async function watchTick(now = new Date()): Promise<number> {
  if (state.running) return 0;
  const day = dayIn(now, TZ);
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }).format(now));
  if (state.lastDay === day || hour < 6) return 0;
  state.running = true;
  let n = 0;
  try {
    const { dailyWatch, graphsWithCommitments } = await import("./run");
    for (const graphId of await graphsWithCommitments()) {
      try {
        const r = await dailyWatch(graphId, now);
        n += r.clashes + r.done + r.fixes;
      } catch (e) {
        console.error("[commitments/watch] daily run failed for a graph:", e instanceof Error ? e.message : e);
      }
    }
    state.lastDay = day;
    if (n) console.log(`[commitments/watch] daily run proposed ${n}`);
  } finally {
    state.running = false;
  }
  return n;
}

export function startCommitmentWatch(): void {
  if (state.started || process.env.DISABLE_SCHEDULER === "1") return;
  state.started = true;
  state.timer = setInterval(() => { void watchTick().catch((e) => console.error("[commitments/watch]", e)); }, 60 * 60_000);
  (state.timer as { unref?: () => void }).unref?.();
  setTimeout(() => { void watchTick().catch((e) => console.error("[commitments/watch]", e)); }, 2 * 60_000).unref?.();
}

export function stopCommitmentWatch(): void {
  if (state.timer) clearInterval(state.timer);
  state.timer = undefined;
  state.started = false;
}
