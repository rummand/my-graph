import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { users } from "@/db/schema";
import { AuthFrame } from "../login/auth-frame";
import { SetupForm } from "./setup-form";

export const metadata: Metadata = { title: "Set up My Graph" };
export const dynamic = "force-dynamic";

/** First run only: once anyone has an account, this page sends people to sign in. */
export default async function SetupPage() {
  const [anyUser] = await db.select({ id: users.id }).from(users).limit(1);
  if (anyUser) redirect("/login");
  return (
    <AuthFrame title="Set up My Graph"
      lead="Create your household and your own account. You'll be the owner, and you can add the rest of the family afterwards."
      footer="Everything stays on this server. Nothing is shared outside your household.">
      <SetupForm />
    </AuthFrame>
  );
}
