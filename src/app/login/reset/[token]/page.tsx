import type { Metadata } from "next";
import Link from "next/link";
import { peekResetToken } from "@/lib/auth/account-controls";
import { isWellFormedToken } from "@/lib/auth/session";
import { MIN_PASSWORD } from "@/lib/auth/passwords";
import { getT } from "@/lib/i18n";
import { buttonClass } from "@/components/ui";
import { AuthFrame } from "../../auth-frame";
import { ResetForm } from "./reset-form";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("settings.resetLink.meta"), referrer: "no-referrer" };
}
export const dynamic = "force-dynamic";

/** A one-time password reset link made in the admin console (24 hours, single use). */
export default async function ResetPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const t = await getT();
  const peek = isWellFormedToken(token) ? await peekResetToken(token) : { state: "missing" as const, user: null };
  if (!peek.user) {
    return (
      <AuthFrame title={t("settings.resetLink.brokenTitle")} lead={t(`settings.resetLink.state.${peek.state}`)}>
        <Link href="/login" className={buttonClass("primary")}>{t("settings.resetLink.toSignIn")}</Link>
      </AuthFrame>
    );
  }
  return (
    <AuthFrame title={t("settings.resetLink.title")} lead={t("settings.resetLink.lead", { name: peek.user.name, email: peek.user.email })}>
      <ResetForm token={token} minLength={MIN_PASSWORD} />
    </AuthFrame>
  );
}
