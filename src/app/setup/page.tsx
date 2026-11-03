import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { users } from "@/db/schema";
import { AuthFrame } from "../login/auth-frame";
import { Mark } from "@/components/shell";
import { SetupForm } from "./setup-form";

export const metadata: Metadata = { title: "Set up My Graph" };
export const dynamic = "force-dynamic";

/** First run only: once anyone has an account, this page sends people to sign in. */
export default async function SetupPage() {
  const [anyUser] = await db.select({ id: users.id }).from(users).limit(1);
  if (anyUser) redirect("/login");
  return (
    <AuthFrame title="Let's set up your family"
      lead="Two short steps. It takes about a minute."
      welcome={{
        title: "A private place for everything your family knows.",
        body: "Start with your household and your own account. Then add the others: each person gets their own private brain, and children's new devices wait for a parent's approval.",
      }}>
      <SetupForm mark={<Mark size={28} />} />
    </AuthFrame>
  );
}
