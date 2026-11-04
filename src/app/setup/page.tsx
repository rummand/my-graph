import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { users } from "@/db/schema";
import { AuthFrame } from "../login/auth-frame";
import { Mark } from "@/components/shell";
import { SetupForm } from "./setup-form";
import { getT } from "@/lib/i18n";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("auth.setup.meta") };
}
export const dynamic = "force-dynamic";

/** First run only: once anyone has an account, this page sends people to sign in. */
export default async function SetupPage() {
  const [anyUser] = await db.select({ id: users.id }).from(users).limit(1);
  if (anyUser) redirect("/login");
  const t = await getT();
  return (
    <AuthFrame title={t("auth.setup.title")} lead={t("auth.setup.lead")}
      welcome={{ title: t("auth.setup.welcomeTitle"), body: t("auth.setup.welcomeBody") }}>
      <SetupForm mark={<Mark size={28} />} />
    </AuthFrame>
  );
}
