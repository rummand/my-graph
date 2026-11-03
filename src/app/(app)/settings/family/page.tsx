import type { Metadata } from "next";
import { EmptyState } from "@/components/ui";
import { isParent, requireUser } from "@/lib/auth";
import { familyMembers } from "@/lib/auth/settings-data";
import { AddMemberForm } from "../_components/add-member-form";
import { MemberList } from "../_components/member-list";
import { PendingApprovals } from "../_components/pending-approvals";
import { Section } from "../_components/section";

export const metadata: Metadata = { title: "Family" };
export const dynamic = "force-dynamic";

export default async function FamilyPage({ searchParams }: { searchParams: Promise<{ welcome?: string }> }) {
  const v = await requireUser();
  if (!isParent(v)) {
    return <EmptyState title="Only parents can manage the family">Ask a parent if something about your account needs changing.</EmptyState>;
  }
  const sp = await searchParams;
  const members = await familyMembers(v);
  const pending = members.flatMap((m) => m.sessions.filter((s) => !s.approved).map((s) => ({ ...s, memberName: m.name, memberRole: m.role, canManage: m.canManage })));
  return (
    <>
      {sp.welcome && (
        <p role="status" className="mb-6 rounded-md bg-accent-tint px-4 py-3 text-sm text-accent">
          Welcome to My Graph. Add the rest of your family below — each person gets their own private brain, and children&apos;s new devices wait for your approval.
        </p>
      )}
      {pending.length > 0 && (
        <Section id="approvals" title="Devices waiting for approval"
          lead="Children and guests need a parent's OK the first time they sign in on a new device. Only approve devices you recognise.">
          <PendingApprovals pending={pending} />
        </Section>
      )}
      <Section id="members" title="Family members" lead="Everyone with an account in your household. Each person has their own brain; what they share is up to them and the visibility you set.">
        <MemberList members={members} viewerRole={v.role} />
      </Section>
      <Section id="add" title="Add a family member" lead="They'll sign in with the email or username and password you set here, and can change the password afterwards.">
        <AddMemberForm canAddParent={v.role === "owner"} />
      </Section>
    </>
  );
}
