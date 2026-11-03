import type { Metadata } from "next";
import { getViewer } from "@/lib/auth";
import { GraphError, previewInvite, type InvitePreview } from "@/lib/graphs";
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

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-4 py-12">
      {!invite || problem ? (
        <section className="rounded-xl border border-line bg-surface p-6">
          <h1 className="text-lg font-semibold">This invite can&apos;t be used</h1>
          <p className="mt-2 text-sm text-muted">{problem}</p>
        </section>
      ) : (
        <section className="rounded-xl border border-line bg-surface p-6">
          <p className="text-sm text-muted">{invite.inviterName} invited you to</p>
          <h1 className="mt-1 text-2xl font-semibold">{invite.graphName}</h1>
          <p className="mt-3 text-sm text-muted">
            You&apos;ll see what is in this graph, and only this graph. {invite.role === "editor" ? "You can add to it too." : "You can look, but not change anything."}
          </p>
          <AcceptInvite
            token={token}
            invite={invite}
            signedInAs={viewer ? { name: viewer.name, email: viewer.email } : null}
          />
        </section>
      )}
    </main>
  );
}
