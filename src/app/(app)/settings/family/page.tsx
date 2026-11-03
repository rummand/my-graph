import type { Metadata } from "next";
import { Badge, EmptyState, PageHeader } from "@/components/ui";
import { isParent, requireUser } from "@/lib/auth";
import { familyMembers } from "@/lib/auth/settings-data";
import { AddMemberForm } from "../_components/add-member-form";
import { MemberList } from "../_components/member-list";
import { PendingApprovals } from "../_components/pending-approvals";
import { Row } from "../_components/section";
import { plural } from "../_components/format";

export const metadata: Metadata = { title: "Family" };
export const dynamic = "force-dynamic";

export default async function FamilyPage({ searchParams }: { searchParams: Promise<{ welcome?: string }> }) {
  const v = await requireUser();
  if (!isParent(v)) {
    return <EmptyState title="Only parents can manage the family">Ask a parent if something about your account needs changing.</EmptyState>;
  }
  const sp = await searchParams;
  const members = await familyMembers(v);
  const pending = members.flatMap((m) => m.sessions.filter((s) => !s.approved).map((s) => ({
    ...s, memberName: m.name, memberRole: m.role, memberId: m.personNodeId ?? m.id, canManage: m.canManage,
  })));
  const kids = members.filter((m) => m.role === "child").length;
  const adults = members.filter((m) => m.role === "owner" || m.role === "parent").length;
  const guests = members.filter((m) => m.role === "guest").length;
  const summary = [plural(adults, "parent"), kids ? plural(kids, "child", "children") : null, guests ? plural(guests, "guest") : null].filter(Boolean).join(", ");
  return (
    <>
      <PageHeader title="Family" lead={`${summary}. Each person has their own private brain; what they share is up to them.`} />
      {sp.welcome && (
        <div role="status" className="mb-8 rounded-lg bg-accent-tint px-5 py-4 text-accent">
          <p className="font-medium">Your household is ready.</p>
          <p className="mt-0.5 text-sm">Add the rest of your family below. Everyone gets their own private brain, and children&apos;s new devices wait for your approval.</p>
        </div>
      )}
      {pending.length > 0 && (
        <Row id="approvals" tone="warn" flush
          title={<span className="flex items-center gap-2">Waiting for your OK <Badge tone="warn">{pending.length}</Badge></span>}
          lead="Children and guests need a parent's approval the first time they sign in on a new device. Only approve devices you recognise.">
          <PendingApprovals pending={pending} />
        </Row>
      )}
      <Row id="members" title="Members" flush
        lead="Everyone with an account in your household. Open a person to change their details, reset their password or see their devices.">
        <MemberList members={members} viewerRole={v.role} />
      </Row>
      <AddMemberForm canAddParent={v.role === "owner"} />
    </>
  );
}
