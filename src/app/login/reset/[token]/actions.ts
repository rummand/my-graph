"use server";
import { headers } from "next/headers";
import { z } from "zod";
import { writeAudit } from "@/lib/auth/audit";
import { peekResetToken, redeemResetToken } from "@/lib/auth/account-controls";
import { passwordProblem } from "@/lib/auth/passwords";
import { clientIp, loginLimiter } from "@/lib/auth/rate-limit";
import { isWellFormedToken } from "@/lib/auth/session";
import { getT } from "@/lib/i18n";

const input = z.object({ token: z.string().max(64), password: z.string().min(1).max(200) });

export type ResetResult = { ok: true } | { ok: false; error: string; field?: "password" };

/** Use a one-time reset link: choose a new password. Server actions are same-origin only (Next checks Origin). */
export async function resetPassword(raw: { token: string; password: string }): Promise<ResetResult> {
  const t = await getT();
  const parsed = input.safeParse(raw);
  if (!parsed.success || !isWellFormedToken(parsed.data.token)) return { ok: false, error: t("settings.resetLink.invalid") };
  const { token, password } = parsed.data;
  const key = `reset|${clientIp(await headers())}`;
  if (!loginLimiter.check(key).allowed) return { ok: false, error: t("settings.resetLink.tooMany") };

  const peek = await peekResetToken(token);
  if (!peek.user) {
    loginLimiter.fail(key);
    return { ok: false, error: t(`settings.resetLink.state.${peek.state}`) };
  }
  const problem = passwordProblem(password, { email: peek.user.email, name: peek.user.name });
  if (problem) return { ok: false, error: problem, field: "password" };

  const r = await redeemResetToken(token, password);
  if (!r.ok) {
    loginLimiter.fail(key);
    return { ok: false, error: t(`settings.resetLink.state.${r.state}`) };
  }
  loginLimiter.reset(key);
  await writeAudit({ id: r.userId, householdId: r.householdId }, "password.reset_link_used", { type: "user", id: r.userId });
  return { ok: true };
}
