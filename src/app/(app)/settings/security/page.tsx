import type { Metadata } from "next";
import { getSession, requireUser } from "@/lib/auth";
import { myPasskeys, mySessions } from "@/lib/auth/settings-data";
import { PasskeyList } from "../_components/passkey-list";
import { Section } from "../_components/section";
import { SessionList } from "../_components/session-list";

export const metadata: Metadata = { title: "Sign-in & devices" };
export const dynamic = "force-dynamic";

export default async function SecurityPage() {
  const v = await requireUser();
  const s = await getSession();
  const [pks, sessions] = await Promise.all([myPasskeys(v), mySessions(v, s.status === "active" ? s.sessionId : null)]);
  return (
    <>
      <Section id="passkeys" title="Passkeys"
        lead="Sign in with your fingerprint, face or device PIN instead of typing a password. Add one on each phone or computer you use.">
        <PasskeyList passkeys={pks} />
      </Section>
      <Section id="sessions" title="Where you're signed in" lead="Sign out of any device you don't recognise or no longer use.">
        <SessionList sessions={sessions} />
      </Section>
    </>
  );
}
