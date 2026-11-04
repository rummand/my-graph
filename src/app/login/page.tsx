import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { safeNext } from "@/lib/auth/session";
import { AuthFrame } from "./auth-frame";
import { LoginForm } from "./login-form";
import { getT } from "@/lib/i18n";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("auth.login.meta") };
}
export const dynamic = "force-dynamic";

const REASONS = new Set(["signed_out", "expired", "access_ended"]);

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; reason?: string }> }) {
  const sp = await searchParams;
  const next = safeNext(sp.next);
  const [anyUser] = await db.select({ id: users.id }).from(users).limit(1);
  if (!anyUser) redirect("/setup");
  const s = await getSession();
  if (s.status === "active") redirect(next);
  if (s.status === "pending") redirect("/login/pending");
  const t = await getT();
  const notice = sp.reason && REASONS.has(sp.reason) ? t(`auth.login.reasons.${sp.reason}`) : null;
  return (
    <AuthFrame title={t("auth.login.title")} lead={t("auth.login.lead")} footer={t("auth.login.footer")}>
      <LoginForm next={next} notice={notice} />
    </AuthFrame>
  );
}
