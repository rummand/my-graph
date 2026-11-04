import { and, eq, gt } from "drizzle-orm";
import { db } from "@/db";
import { automationRuns } from "@/db/schema";
import { ownAutomationRow } from "@/lib/automations/automations";
import { errorJson, parseId, route } from "@/lib/automations/http";
import { executeAutomation, isRunningHere } from "@/lib/automations/runner";
import { CLAIM_LEASE_MS } from "@/lib/automations/schedule";

type Ctx = { params: Promise<{ id: string }> };

/** POST: run it now, as me. Returns at once; poll GET …/runs for the result. */
export const POST = route<Ctx>(async (_req, v, { params }) => {
  const a = await ownAutomationRow(v, parseId((await params).id, "That automation"));
  const [busy] = await db.select({ id: automationRuns.id }).from(automationRuns)
    .where(and(eq(automationRuns.automationId, a.id), eq(automationRuns.status, "running"), gt(automationRuns.startedAt, new Date(Date.now() - CLAIM_LEASE_MS)))).limit(1);
  if (busy || isRunningHere(a.id)) return errorJson(409, "It's already running. The result will appear here when it's done.");
  const startedAt = new Date();
  void executeAutomation(a, { manual: true, now: startedAt }).catch(() => {});
  return Response.json({ started: true, startedAt: startedAt.toISOString() }, { status: 202 });
}, { write: true });
