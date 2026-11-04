/**
 * The in-process scheduler (server-only). Every minute it claims due automations atomically with
 * `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING`, pushing their next_run_at out by a lease, so two
 * app instances never run the same automation twice; a run that dies mid-way is picked up again when the lease ends.
 * It never throws: every error is logged and the next tick carries on.
 */
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { automations } from "@/db/schema";
import { executeAutomation } from "./runner";
import { CLAIM_BATCH, CLAIM_LEASE_MS, TICK_MS } from "./schedule";

type AutomationRow = typeof automations.$inferSelect;
type State = { timer?: ReturnType<typeof setInterval>; keeperTimer?: ReturnType<typeof setInterval>; keeperTicking?: boolean; ticking: boolean; started: boolean };
const g = globalThis as unknown as { __mgScheduler?: State };
const state: State = g.__mgScheduler ?? (g.__mgScheduler = { ticking: false, started: false });

/** Claim up to `limit` due automations. Exported for the DB test and the integrator's tooling. */
export async function claimDue(limit = CLAIM_BATCH): Promise<AutomationRow[]> {
  const leaseSeconds = Math.round(CLAIM_LEASE_MS / 1000);
  const rows = await db.execute<Record<string, unknown>>(sql`
    update ${automations} set next_run_at = now() + make_interval(secs => ${leaseSeconds})
    where id in (
      select id from ${automations}
      where enabled = true and next_run_at is not null and next_run_at <= now()
      order by next_run_at
      limit ${limit}
      for update skip locked
    )
    returning id, graph_id, owner_id, name, prompt, recipe_id, trigger, config, one_shot, enabled, next_run_at, last_run_at, created_at, updated_at`);
  return (rows as unknown as Record<string, unknown>[]).map((r) => ({
    id: String(r.id), graphId: String(r.graph_id), ownerId: String(r.owner_id), name: String(r.name), prompt: String(r.prompt),
    recipeId: (r.recipe_id as string | null) ?? null, trigger: r.trigger as AutomationRow["trigger"], config: (r.config as Record<string, unknown>) ?? {},
    oneShot: Boolean(r.one_shot), enabled: Boolean(r.enabled), nextRunAt: toDate(r.next_run_at), lastRunAt: toDate(r.last_run_at),
    createdAt: toDate(r.created_at) ?? new Date(), updatedAt: toDate(r.updated_at) ?? new Date(),
  }));
}

function toDate(x: unknown): Date | null {
  if (!x) return null;
  const d = x instanceof Date ? x : new Date(String(x));
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function tick(): Promise<number> {
  if (state.ticking) return 0;
  state.ticking = true;
  let n = 0;
  try {
    const due = await claimDue();
    for (const a of due) {
      // The claimed row's next_run_at is the lease; the runner computes the real next time from the trigger.
      await executeAutomation(a);
      n++;
    }
  } catch (e) {
    console.error("[scheduler] tick failed:", e instanceof Error ? e.message : e);
  } finally {
    state.ticking = false;
  }
  return n;
}

export function start(): void {
  if (state.started) return;
  if (process.env.DISABLE_SCHEDULER === "1") return;
  state.started = true;
  state.timer = setInterval(() => { void tick(); }, TICK_MS);
  // Don't keep a process alive (scripts, tests) just for the scheduler.
  (state.timer as { unref?: () => void }).unref?.();
  setTimeout(() => { void tick(); }, 10_000).unref?.();
  // The Brain Keeper: every 15 minutes, for each person with new material since its last run (src/lib/keeper).
  const keep = () => {
    if (state.keeperTicking) return;
    state.keeperTicking = true;
    void import("@/lib/keeper").then((k) => k.keeperTick()).catch((e) => console.error("[scheduler] keeper tick failed:", e instanceof Error ? e.message : e))
      .finally(() => { state.keeperTicking = false; });
  };
  state.keeperTimer = setInterval(keep, 15 * 60_000);
  (state.keeperTimer as { unref?: () => void }).unref?.();
  setTimeout(keep, 5 * 60_000).unref?.();
  console.log("[scheduler] started (every 60s; Brain Keeper every 15 min)");
}

export function stop(): void {
  if (state.timer) clearInterval(state.timer);
  if (state.keeperTimer) clearInterval(state.keeperTimer);
  state.timer = undefined;
  state.keeperTimer = undefined;
  state.started = false;
}
