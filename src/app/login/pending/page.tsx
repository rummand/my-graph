import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getSession } from "@/lib/auth";
import { describeUserAgent } from "@/lib/auth/session";
import { AuthFrame } from "../auth-frame";
import { PendingWatcher } from "./pending-watcher";
import { getT } from "@/lib/i18n";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("auth.pending.meta") };
}
export const dynamic = "force-dynamic";

export default async function PendingPage() {
  const s = await getSession();
  if (s.status === "active") redirect("/");
  if (s.status === "none") redirect("/login");
  const device = describeUserAgent((await headers()).get("user-agent"));
  const known = device !== "Unknown device";
  const t = await getT();
  return (
    <AuthFrame title={t("auth.pending.title")}
      lead={known ? t("auth.pending.leadKnown", { name: s.viewer.name, device }) : t("auth.pending.leadUnknown", { name: s.viewer.name })}
      welcome={{ title: t("auth.pending.welcomeTitle"), body: t("auth.pending.welcomeBody") }}>
      <div className="rounded-lg bg-warn-tint p-4">
        <PendingWatcher />
        <p className="mt-2 text-sm text-fg/80">{t("auth.pending.how")}</p>
      </div>
      <form action="/api/auth/logout" method="post" className="mt-6">
        <button className="text-sm text-muted underline underline-offset-2 hover:text-fg">{t("auth.pending.signOut")}</button>
      </form>
    </AuthFrame>
  );
}
