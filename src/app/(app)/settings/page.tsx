import type { Metadata } from "next";
import { PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { roleLabel } from "@/lib/auth/audit-labels";
import { myAccount } from "@/lib/auth/settings-data";
import { PasswordForm, ProfileForm } from "./_components/profile-forms";
import { Row } from "./_components/section";
import { fmtDate } from "./_components/format";

export const metadata: Metadata = { title: "Profile" };
export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const v = await requireUser();
  const acct = await myAccount(v);
  const home = acct.householdName || "your household";
  const role = v.role === "owner" ? `the owner of ${home}` : `a ${roleLabel(v.role).toLowerCase()} in ${home}`;
  return (
    <>
      <PageHeader title="Profile" lead={<>You&apos;re {role}{acct.createdAt ? <>, here since {fmtDate(acct.createdAt)}</> : null}.</>} />
      <ProfileForm name={v.name} email={v.email} personId={v.personNodeId ?? v.id} />
      <Row id="password" title={acct.hasPassword ? "Password" : "Add a password"}
        lead={acct.hasPassword
          ? "A new password signs you out on your other phones and computers, unless you untick the box."
          : "You sign in with a passkey only. A password is a useful backup if you lose this device."}>
        <PasswordForm hasPassword={acct.hasPassword} />
      </Row>
    </>
  );
}
