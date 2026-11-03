import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { roleLabel } from "@/lib/auth/audit-labels";
import { myAccount } from "@/lib/auth/settings-data";
import { PasswordForm, ProfileForm } from "./_components/profile-forms";
import { Section } from "./_components/section";

export const metadata: Metadata = { title: "Profile" };
export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const v = await requireUser();
  const acct = await myAccount(v);
  return (
    <>
      <Section id="profile" title="Profile" lead={<>You&apos;re {v.role === "owner" ? "the owner" : `a ${roleLabel(v.role).toLowerCase()}`} in {acct.householdName || "your household"}.</>}>
        <ProfileForm name={v.name} email={v.email} />
      </Section>
      <Section id="password" title={acct.hasPassword ? "Change password" : "Set a password"}
        lead={acct.hasPassword ? "Choosing a new password signs you out on your other devices unless you untick the box." : "You sign in with a passkey only. A password is a useful backup."}>
        <PasswordForm hasPassword={acct.hasPassword} />
      </Section>
    </>
  );
}
