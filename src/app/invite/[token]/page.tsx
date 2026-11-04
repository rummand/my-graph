import type { Metadata } from "next";
import Link from "next/link";
import { getViewer } from "@/lib/auth";
import { GraphError, previewInvite, type InvitePreview } from "@/lib/graphs";
import { AuthFrame } from "@/app/login/auth-frame";
import { buttonClass } from "@/components/ui";
import { AcceptInvite } from "./accept-invite";
import { getFormatDate, getT } from "@/lib/i18n";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("auth.invite.meta") };
}
export const dynamic = "force-dynamic";

/** The page an invite link opens. Public: it shows only the graph's name, who invited you and the email it is for. */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const [t, fmt] = await Promise.all([getT(), getFormatDate()]);
  let invite: InvitePreview | null = null;
  let problem: string | null = null;
  try {
    invite = await previewInvite(token);
  } catch (e) {
    problem = e instanceof GraphError ? e.message : t("auth.invite.cantUse");
  }
  const viewer = await getViewer();

  if (!invite) {
    return (
      <AuthFrame title={t("auth.invite.cantUseTitle")} lead={problem}
        welcome={{ title: t("auth.invite.cantUseWelcomeTitle"), body: t("auth.invite.cantUseWelcomeBody") }}>
        <Link href={viewer ? "/" : "/login"} className={buttonClass("secondary")}>{viewer ? t("auth.invite.openApp") : t("auth.invite.signIn")}</Link>
      </AuthFrame>
    );
  }

  const inviter = invite.inviterName.split(/\s+/)[0] || invite.inviterName;
  return (
    <AuthFrame
      title={t("auth.invite.title", { graph: invite.graphName })}
      lead={t(invite.role === "viewer" ? "auth.invite.leadView" : "auth.invite.leadEdit", { inviter, email: invite.email })}
      welcome={{
        title: t("auth.invite.welcomeTitle", { inviter, graph: invite.graphName }),
        body: t("auth.invite.welcomeBody", { inviter }),
      }}
      footer={invite.state === "open" ? t("auth.invite.footer", { date: fmt(invite.expiresAt, "weekday") }) : undefined}
    >
      <AcceptInvite token={token} invite={invite} signedInAs={viewer ? { name: viewer.name, email: viewer.email } : null} />
    </AuthFrame>
  );
}
