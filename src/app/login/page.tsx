import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { safeNext } from "@/lib/auth/session";
import { AuthFrame } from "./auth-frame";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

const REASONS: Record<string, string> = {
  signed_out: "You're signed out.",
  expired: "Your session ended. Please sign in again.",
  access_ended: "Your guest access has ended. Ask the family to extend it.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; reason?: string }> }) {
  const sp = await searchParams;
  const next = safeNext(sp.next);
  const [anyUser] = await db.select({ id: users.id }).from(users).limit(1);
  if (!anyUser) redirect("/setup");
  const s = await getSession();
  if (s.status === "active") redirect(next);
  if (s.status === "pending") redirect("/login/pending");
  const notice = sp.reason ? REASONS[sp.reason] ?? null : null;
  return (
    <AuthFrame title="Sign in" lead="Your family's private brain." footer="Forgot your password? Ask a parent in your household to set a new one.">
      <LoginForm next={next} notice={notice} />
    </AuthFrame>
  );
}
