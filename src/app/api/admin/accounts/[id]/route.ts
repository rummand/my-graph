import { z } from "zod";
import { AuthError, parseBody, parseParams } from "@/lib/auth/http";
import { issueResetToken, setLocked, setTemporaryPassword, signOutEverywhere } from "@/lib/auth/account-controls";
import { findUserById } from "@/lib/auth/signin";
import { adminHandle, auditAdmin, publicBaseUrl, requirePlatformAdminApi } from "@/lib/plans/admin";
import { accountDetail } from "@/lib/plans/admin-data";
import { ADDON_KEYS, emailIsAdmin } from "@/lib/plans/catalog";
import { adminEmails, setAccountAddon, setAccountPlan } from "@/lib/plans/store";

type Ctx = { params: Promise<{ id: string }> };
const params = z.object({ id: z.string().uuid("That account doesn't exist.") });

const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set_plan"), plan: z.string().min(1).max(40) }),
  z.object({ action: z.literal("set_addon"), addon: z.enum(ADDON_KEYS as [string, ...string[]]), enabled: z.boolean() }),
  z.object({ action: z.literal("lock"), reason: z.string().max(300).optional() }),
  z.object({ action: z.literal("unlock") }),
  z.object({ action: z.literal("sign_out") }),
  z.object({ action: z.literal("reset_link") }),
  z.object({ action: z.literal("temp_password") }),
]);

/** GET: one account's metadata, plan, add-ons, controls and the admin actions taken on it. */
export async function GET(req: Request, ctx: Ctx) {
  return adminHandle(async () => {
    await requirePlatformAdminApi(req);
    const { id } = parseParams(await ctx.params, params);
    const a = await accountDetail(id);
    if (!a) throw new AuthError(404, "That account doesn't exist.");
    return Response.json({ account: a });
  });
}

/**
 * POST { action, ... }: change plan, toggle an Ultimate add-on, lock / unlock, sign out everywhere, make a one-time
 * reset link (no mail sender exists, so the link is returned to copy) or set a temporary password. Every action is
 * written to the audit log with the admin's id; if that write fails, the request fails.
 */
export async function POST(req: Request, ctx: Ctx) {
  return adminHandle(async () => {
    const admin = await requirePlatformAdminApi(req);
    const { id } = parseParams(await ctx.params, params);
    const b = await parseBody(req, body);
    const target = await findUserById(id);
    if (!target) throw new AuthError(404, "That account doesn't exist.");
    const ref = { type: "user", id: target.id };
    const who = { targetEmail: target.email, targetName: target.name };
    const targetIsAdmin = emailIsAdmin(target.email, adminEmails());
    const self = target.id === admin.id;

    switch (b.action) {
      case "set_plan": {
        if (targetIsAdmin) throw new AuthError(409, "Platform admins are always on Ultimate.");
        const { from } = await setAccountPlan(target.id, b.plan, admin.id);
        await auditAdmin(admin, "admin.plan_change", ref, { ...who, from, to: b.plan });
        return Response.json({ ok: true });
      }
      case "set_addon": {
        if (targetIsAdmin && !b.enabled) throw new AuthError(409, "Platform admins always have every add-on.");
        await setAccountAddon(target.id, b.addon, b.enabled, admin.id);
        await auditAdmin(admin, b.enabled ? "admin.addon_grant" : "admin.addon_revoke", ref, { ...who, addon: b.addon });
        return Response.json({ ok: true });
      }
      case "lock": {
        if (self || targetIsAdmin) throw new AuthError(409, "You can't lock a platform admin's account from here.");
        const { signedOut } = await setLocked(target.id, true, admin.id, b.reason);
        await auditAdmin(admin, "admin.lock", ref, { ...who, reason: b.reason?.trim() || null, signedOutSessions: signedOut });
        return Response.json({ ok: true, signedOut });
      }
      case "unlock": {
        await setLocked(target.id, false, admin.id);
        await auditAdmin(admin, "admin.unlock", ref, who);
        return Response.json({ ok: true });
      }
      case "sign_out": {
        if (self) throw new AuthError(409, "Use Sign-in & devices in your own settings to sign yourself out.");
        const signedOut = await signOutEverywhere(target.id);
        await auditAdmin(admin, "admin.sign_out_all", ref, { ...who, signedOutSessions: signedOut });
        return Response.json({ ok: true, signedOut });
      }
      case "reset_link": {
        const { token, expiresAt } = await issueResetToken(target.id, admin.id);
        await auditAdmin(admin, "admin.reset_link", ref, { ...who, expiresAt: expiresAt.toISOString() });
        return Response.json({ ok: true, url: `${publicBaseUrl(req)}/login/reset/${token}`, expiresAt: expiresAt.toISOString() },
          { headers: { "Cache-Control": "no-store" } });
      }
      case "temp_password": {
        if (self) throw new AuthError(409, "Change your own password in your settings.");
        const { password, signedOut } = await setTemporaryPassword(target.id);
        await auditAdmin(admin, "admin.temp_password", ref, { ...who, signedOutSessions: signedOut });
        return Response.json({ ok: true, password, signedOut }, { headers: { "Cache-Control": "no-store" } });
      }
    }
  });
}
