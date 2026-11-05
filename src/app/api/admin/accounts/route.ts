import { z } from "zod";
import { parseBody, parseParams } from "@/lib/auth/http";
import { issueResetToken, setTemporaryPassword } from "@/lib/auth/account-controls";
import { adminHandle, auditAdmin, publicBaseUrl, requirePlatformAdminApi } from "@/lib/plans/admin";
import { createAccountByAdmin, newAccountBody } from "@/lib/plans/admin-create";
import { listAccounts } from "@/lib/plans/admin-data";
import { PlanError, listPlans, setAccountPlan } from "@/lib/plans/store";

const query = z.object({ q: z.string().max(200).optional() });

/** GET ?q= : accounts (metadata only). Platform admin only; 404 for everyone else. */
export async function GET(req: Request) {
  return adminHandle(async () => {
    await requirePlatformAdminApi(req);
    const { q } = parseParams(Object.fromEntries(new URL(req.url).searchParams), query);
    return Response.json({ accounts: await listAccounts({ q }) });
  });
}

/**
 * POST { name, email, householdName?, firstGraph, plan?, access }: a new account with a household of its own and a
 * first graph. No mail sender exists, so the way in is returned to copy: a one-time link to choose a password (24 h)
 * or a temporary password they must change at first sign-in. Audited; if the audit write fails, the request fails.
 */
export async function POST(req: Request) {
  return adminHandle(async () => {
    const admin = await requirePlatformAdminApi(req);
    const b = await parseBody(req, newAccountBody);
    // Check the plan first, so a bad plan can't leave a half-made account behind.
    if (b.plan && !(await listPlans()).some((p) => p.key === b.plan)) throw new PlanError(400, "There is no plan with that name.");
    const { userId, householdId } = await createAccountByAdmin(b);
    if (b.plan) await setAccountPlan(userId, b.plan, admin.id);
    const ref = { type: "user", id: userId };
    const who = { targetEmail: b.email, targetName: b.name };
    await auditAdmin(admin, "admin.account_create", ref, { ...who, householdId, firstGraph: b.firstGraph, plan: b.plan ?? null, access: b.access });

    const headers = { "Cache-Control": "no-store" };
    if (b.access === "temp") {
      const { password } = await setTemporaryPassword(userId);
      await auditAdmin(admin, "admin.temp_password", ref, { ...who, signedOutSessions: 0 });
      return Response.json({ ok: true, id: userId, password }, { status: 201, headers });
    }
    const { token, expiresAt } = await issueResetToken(userId, admin.id);
    await auditAdmin(admin, "admin.reset_link", ref, { ...who, expiresAt: expiresAt.toISOString() });
    return Response.json({ ok: true, id: userId, url: `${publicBaseUrl(req)}/login/reset/${token}`, expiresAt: expiresAt.toISOString() },
      { status: 201, headers });
  });
}
