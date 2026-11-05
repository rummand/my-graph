import { NextResponse } from "next/server";
import { z } from "zod";
import { audit, requireUserApi } from "@/lib/auth";
import { actOnCommitment, getCommitment, readablePeople } from "@/lib/commitments";
import { scopeOf } from "@/lib/graphs/pure";
import { handle, jsonError } from "../http";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };
const id = z.object({ id: z.uuid() });
const iso = z.string().trim().max(40).refine((s) => !Number.isNaN(Date.parse(s)), "Use a date such as 2026-11-14.");
const amount = z.object({ value: z.number().finite().min(0).max(1e9), currency: z.string().trim().regex(/^[A-Za-z]{3}$/, "A currency such as DKK") }).strict();

const action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("done"), note: z.string().trim().max(500).optional(), evidenceSourceId: z.uuid().optional() }).strict(),
  z.object({ action: z.literal("reopen") }).strict(),
  z.object({ action: z.literal("snooze"), until: iso }).strict(),
  z.object({ action: z.literal("progress"), note: z.string().trim().max(500).optional() }).strict(),
  z.object({ action: z.literal("reassign"), personId: z.uuid() }).strict(),
  z.object({
    action: z.literal("edit"), label: z.string().trim().min(1).max(200).optional(), dueAt: iso.nullable().optional(), amount: amount.nullable().optional(),
    consequence: z.string().trim().max(500).nullable().optional(), leadDays: z.number().int().min(0).max(365).nullable().optional(),
    recurrence: z.string().trim().max(200).regex(/^(RRULE:)?FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;[A-Z]+=[A-Z0-9,]+)*$/i, "A rule such as FREQ=YEARLY").nullable().optional(),
  }).strict(),
  z.object({ action: z.literal("cancel"), reason: z.enum(["not_mine", "not_a_commitment", "duplicate", "cancelled"]).optional(), note: z.string().trim().max(500).optional() }).strict(),
]);

/** GET /api/commitments/:id → { commitment, everyone, canWrite } (404 when the viewer may not read it, so ids don't leak). */
export function GET(_req: Request, ctx: Ctx) {
  return handle(async () => {
    const v = await requireUserApi();
    const p = id.safeParse(await ctx.params);
    if (!p.success) return jsonError(404, "We couldn't find that commitment.");
    const commitment = await getCommitment(v, p.data.id);
    if (!commitment) return jsonError(404, "We couldn't find that commitment.");
    const canWrite = scopeOf(v).canWrite && v.role !== "guest";
    return NextResponse.json({ commitment, canWrite, everyone: canWrite ? await readablePeople(v) : [] });
  });
}

/**
 * POST /api/commitments/:id { action: "done" | "reopen" | "snooze" | "progress" | "reassign" | "edit" | "cancel", … }
 * → { status: "delivered" | "proposed", changeSetId, nextProposalId?, commitment }. The person's own decision: a
 * change set they author and deliver at once, or a proposal when someone else has to decide.
 */
export function POST(req: Request, ctx: Ctx) {
  return handle(async () => {
    const v = await requireUserApi();
    const p = id.safeParse(await ctx.params);
    if (!p.success) return jsonError(404, "We couldn't find that commitment.");
    const body = await req.json().catch(() => null);
    const a = action.safeParse(body);
    if (!a.success) return jsonError(400, a.error.issues[0]?.message ?? "That isn't something you can do here.");
    const r = await actOnCommitment(v, p.data.id, a.data);
    void audit(v, `commitment.${a.data.action}`, { type: "change_set", id: r.changeSetId }, { status: r.status, commitmentId: p.data.id }).catch(() => {});
    return NextResponse.json(r);
  });
}
