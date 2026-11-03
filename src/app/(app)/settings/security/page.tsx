import type { Metadata } from "next";
import { PageHeader } from "@/components/ui";
import { getSession, requireUser } from "@/lib/auth";
import { myPasskeys, mySessions } from "@/lib/auth/settings-data";
import { PasskeyList } from "../_components/passkey-list";
import { Row } from "../_components/section";
import { SessionList } from "../_components/session-list";
import { plural } from "../_components/format";

export const metadata: Metadata = { title: "Sign-in & devices" };
export const dynamic = "force-dynamic";

export default async function SecurityPage() {
  const v = await requireUser();
  const s = await getSession();
  const [pks, sessions] = await Promise.all([myPasskeys(v), mySessions(v, s.status === "active" ? s.sessionId : null)]);
  return (
    <>
      <PageHeader title="Sign-in & devices" lead={`${pks.length ? `You have ${plural(pks.length, "passkey")}` : "No passkeys yet"}, and you're signed in on ${plural(sessions.length, "device")}.`} />
      <Row id="passkeys" title="Passkeys" flush
        lead="Sign in with your fingerprint, face or device PIN instead of typing a password. Add one on each phone and computer you use.">
        <PasskeyList passkeys={pks} />
      </Row>
      <Row id="sessions" title="Where you're signed in" flush
        lead="Every phone, tablet and browser with access to your brain. Sign out of anything you don't recognise.">
        <SessionList sessions={sessions} />
      </Row>
    </>
  );
}
