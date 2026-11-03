import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { describeUserAgent } from "@/lib/auth/session";
import { headers } from "next/headers";
import { AuthFrame } from "../auth-frame";
import { PendingWatcher } from "./pending-watcher";

export const metadata: Metadata = { title: "Waiting for approval" };
export const dynamic = "force-dynamic";

export default async function PendingPage() {
  const s = await getSession();
  if (s.status === "active") redirect("/");
  if (s.status === "none") redirect("/login");
  const device = describeUserAgent((await headers()).get("user-agent"));
  return (
    <AuthFrame title="Ask a parent to approve this device"
      lead={<>Hi {s.viewer.name}. This is the first time you&apos;ve signed in on this {device === "Unknown device" ? "device" : device}. A parent needs to approve it before you can use My Graph here.</>}>
      <div className="space-y-4 text-sm">
        <p>They can do it from <strong>Family &amp; settings → Family</strong> on their own device. This page moves on by itself once they have.</p>
        <PendingWatcher />
        <form action="/api/auth/logout" method="post">
          <button className="text-sm text-muted underline underline-offset-2 hover:text-fg">Sign out</button>
        </form>
      </div>
    </AuthFrame>
  );
}
