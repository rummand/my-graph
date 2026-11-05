/**
 * Deleting an account: the rules, as pure functions (no database), so they can be tested.
 *
 *  - The platform admin can't delete their account here (it would lock everyone out of the admin console).
 *  - Children ask a parent (parents remove accounts under Household).
 *  - A household owner hands the household to another grown-up first, or is its only member (then the household
 *    goes with the account).
 *  - A graph they own that other people use is handed to one of them first (or deleted under Graphs).
 *  - The person types their sign-in email to confirm. Nothing happens for 7 days; signing in again cancels it.
 *  - Then: their private items go everywhere; graphs only they use go; in graphs shared with others, what they
 *    added for others to see stays, attributed to "a former member".
 */

export const GRACE_DAYS = 7;
export const FORMER_MEMBER_NAME = "A former member";
/** Stand-in accounts live in this household and have an address on the reserved .invalid domain. */
export const FORMER_HOUSEHOLD_ID = "00000000-0000-4000-8000-0000f0e1f0e1";
export const FORMER_HOUSEHOLD_NAME = "Former members";
export const FORMER_EMAIL_DOMAIN = "former-member.invalid";

export function formerMemberEmail(id: string): string {
  return `former-${id}@${FORMER_EMAIL_DOMAIN}`;
}

/** True for the stand-in account of someone who deleted theirs (name it "a former member" in the interface). */
export function isFormerMember(email: string | null | undefined): boolean {
  return !!email && email.toLowerCase().endsWith(`@${FORMER_EMAIL_DOMAIN}`);
}

export type Role = "owner" | "parent" | "child" | "guest";

export type DeletionFacts = {
  role: Role;
  isPlatformAdmin: boolean;
  /** Other people in their household (stand-ins excluded). */
  householdOthers: number;
  /** Graphs they own that someone else is a member of (their family graph not included). */
  sharedOwnedGraphs: { id: string; name: string; others: number }[];
};

export type Blocker =
  | { code: "platform_admin" }
  | { code: "child" }
  | { code: "household_owner"; others: number }
  | { code: "shared_graph_owner"; graphs: { id: string; name: string }[] };

export function deletionBlockers(f: DeletionFacts): Blocker[] {
  const out: Blocker[] = [];
  if (f.isPlatformAdmin) out.push({ code: "platform_admin" });
  if (f.role === "child") out.push({ code: "child" });
  if (f.role === "owner" && f.householdOthers > 0) out.push({ code: "household_owner", others: f.householdOthers });
  const shared = f.sharedOwnedGraphs.filter((g) => g.others > 0);
  if (shared.length) out.push({ code: "shared_graph_owner", graphs: shared.map((g) => ({ id: g.id, name: g.name })) });
  return out;
}

/** The typed confirmation: their sign-in email (or username), ignoring case and surrounding spaces. */
export function confirmationMatches(typed: string, email: string): boolean {
  const a = typed.trim().toLowerCase();
  return a.length > 0 && a === email.trim().toLowerCase();
}

export function deletionDueAt(requestedAt: Date): Date {
  return new Date(requestedAt.getTime() + GRACE_DAYS * 86_400_000);
}

/** Signing in after asking cancels: any session started after the request. */
export function signedInSince(sessions: { createdAt: Date }[], requestedAt: Date): boolean {
  return sessions.some((s) => s.createdAt.getTime() > requestedAt.getTime());
}

export type GraphFact = { id: string; ownerId: string | null; kind: string; householdId: string; members: string[] };

/**
 * What happens to each graph: graphs they own (with nobody else in them) are deleted; in every other graph their
 * shared contributions are kept. The household goes too when they are its owner and only member.
 */
export function planDeletion(userId: string, role: Role, householdId: string, householdOthers: number, graphs: GraphFact[]): {
  deleteHousehold: boolean; deleteGraphIds: string[]; keepGraphIds: string[];
} {
  const deleteHousehold = role === "owner" && householdOthers === 0;
  const deleteGraphIds: string[] = [];
  const keepGraphIds: string[] = [];
  for (const g of graphs) {
    const others = g.members.filter((m) => m !== userId).length;
    const own = g.ownerId === userId;
    const goesWithHousehold = deleteHousehold && g.householdId === householdId && others === 0;
    if ((own && others === 0) || goesWithHousehold) deleteGraphIds.push(g.id);
    else keepGraphIds.push(g.id);
  }
  return { deleteHousehold, deleteGraphIds, keepGraphIds };
}

/** An item they added stays (as a former member's) only when it is in a kept graph and others could see it. */
export function keepsItem(item: { ownerId: string; graphId: string; visibility: string }, userId: string, keepGraphIds: Set<string>): boolean {
  if (item.ownerId !== userId) return true; // not theirs: untouched
  return keepGraphIds.has(item.graphId) && item.visibility !== "private";
}
