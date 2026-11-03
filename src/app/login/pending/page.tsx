import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getSession } from "@/lib/auth";
import { describeUserAgent } from "@/lib/auth/session";
import { AuthFrame } from "../auth-frame";
import { PendingWatcher } from "./pending-watcher";

export const metadata: Metadata = { title: "Waiting for approval" };
export const dynamic = "force-dynamic";

export default async function PendingPage() {
  const s = await getSession();
  if (s.status === "active") redirect("/");
  if (s.status === "none") redirect("/login");
  const device = describeUserAgent((await headers()).get("user-agent"));
  const known = device !== "Unknown device";
  return (
    <AuthFrame title="Ask a parent to approve this device"
      lead={<>Hi {s.viewer.name}. This is the first time you&apos;ve signed in on {known ? device : "this device"}, so a parent needs to say it&apos;s OK.</>}
      welcome={{ title: "New devices wait for a parent.", body: "It keeps the family's graph safe if a phone or a password ends up in the wrong hands. It only happens once per device." }}>
      <div className="rounded-lg bg-warn-tint p-4">
        <PendingWatcher />
        <p className="mt-2 text-sm text-fg/80">
          A parent can approve it from <span className="font-medium text-fg">Family &amp; settings</span>, then <span className="font-medium text-fg">Family</span>, on their own phone or computer. This page moves on by itself once they have.
        </p>
      </div>
      <form action="/api/auth/logout" method="post" className="mt-6">
        <button className="text-sm text-muted underline underline-offset-2 hover:text-fg">Sign out</button>
      </form>
    </AuthFrame>
  );
}
