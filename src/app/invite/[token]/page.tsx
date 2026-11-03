import type { Metadata } from "next";
import Link from "next/link";
import { getViewer } from "@/lib/auth";
import { GraphError, previewInvite, type InvitePreview } from "@/lib/graphs";
import { AuthFrame } from "@/app/login/auth-frame";
import { buttonClass } from "@/components/ui";
import { AcceptInvite } from "./accept-invite";

export const metadata: Metadata = { title: "Invitation · My Graph" };
export const dynamic = "force-dynamic";

/** The page an invite link opens. Public: it shows only the graph's name, who invited you and the email it is for. */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let invite: InvitePreview | null = null;
  let problem: string | null = null;
  try {
    invite = await previewInvite(token);
  } catch (e) {
    problem = e instanceof GraphError ? e.message : "This invite link doesn't work. Ask for a new one.";
  }
  const viewer = await getViewer();

  if (!invite) {
    return (
      <AuthFrame title="This invite can't be used" lead={problem}
        welcome={{ title: "A graph someone made to share with you.", body: "Invite links work once and for 14 days. Ask the person who sent it for a new one." }}>
        <Link href={viewer ? "/" : "/login"} className={buttonClass("secondary")}>{viewer ? "Open My Graph" : "Sign in"}</Link>
      </AuthFrame>
    );
  }

  const inviter = invite.inviterName.split(/\s+/)[0] || invite.inviterName;
  const canDo = invite.role === "viewer" ? "look at it" : "add to it";
  return (
    <AuthFrame
      title={`Join ${invite.graphName}`}
      lead={<>{inviter} invited {invite.email} to {canDo}.</>}
      welcome={{
        title: `${inviter} is sharing “${invite.graphName}” with you.`,
        body: <>My Graph keeps people, plans, letters and photos in one place, each fact with a note of where it came from. You&apos;ll see this one graph and nothing else of {inviter}&apos;s, and your own graphs stay yours.</>,
      }}
      footer={invite.state === "open" ? <>The link works once, until <InviteDate iso={invite.expiresAt} />.</> : undefined}
    >
      <AcceptInvite token={token} invite={invite} signedInAs={viewer ? { name: viewer.name, email: viewer.email } : null} />
    </AuthFrame>
  );
}

function InviteDate({ iso }: { iso: string }) {
  const d = new Date(iso);
  return <time dateTime={iso}>{d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}</time>;
}
