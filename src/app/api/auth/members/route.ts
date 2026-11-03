import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { audit, requireParentApi } from "@/lib/auth";
import { AuthError, handle, parseBody } from "@/lib/auth/http";
import { canManageRole, createAccount, createPersonNode, emailTaken, linkParentOf } from "@/lib/auth/members";
import { hashPassword, passwordProblem } from "@/lib/auth/passwords";
import { createMemberBody } from "@/lib/auth/schemas";

/**
 * POST: add a family member (parents only). Creates their account and their own person node; for a child, also a
 * parent_of fact from your person node to theirs.
 */
export async function POST(req: Request) {
  return handle(async () => {
    const v = await requireParentApi();
    const body = await parseBody(req, createMemberBody);
    if (!canManageRole(v.role, body.role)) throw new AuthError(403, "Only the household owner can add another parent.");
    if (await emailTaken(body.email)) {
      throw new AuthError(409, "Someone already signs in with that email or username.", { fields: [{ key: "email", message: "Already in use." }] });
    }
    const problem = passwordProblem(body.password, { email: body.email, name: body.name });
    if (problem) throw new AuthError(400, problem, { fields: [{ key: "password", message: problem }] });
    const passwordHash = await hashPassword(body.password);

    const out = await db.transaction(async (tx) => {
      const acct = await createAccount(tx, {
        householdId: v.householdId, role: body.role, name: body.name, email: body.email, passwordHash,
        birthYear: body.role === "child" ? body.birthYear ?? null : null,
        accessExpiresAt: body.role === "guest" ? body.accessExpiresAt ?? null : null,
      }, v.id);
      let edgeId: string | null = null;
      if (body.role === "child") {
        // From the users row: v.personNodeId is only set while the parent works in the family graph.
        const [me] = await tx.select({ personNodeId: users.personNodeId }).from(users).where(eq(users.id, v.id));
        let parentNode = me?.personNodeId ?? null;
        if (!parentNode) {
          // Older accounts may not have a person node yet: give the parent theirs first.
          parentNode = await createPersonNode(tx, { householdId: v.householdId, ownerId: v.id, label: v.name, role: v.role, agentId: v.id, note: "Created with the account" });
          await tx.update(users).set({ personNodeId: parentNode }).where(eq(users.id, v.id));
        }
        edgeId = await linkParentOf(tx, {
          householdId: v.householdId, parentUserId: v.id, parentNodeId: parentNode, childNodeId: acct.personNodeId, agentId: v.id,
          note: `${v.name} added ${body.name} as their child in Family settings`,
        });
      }
      return { ...acct, edgeId };
    });

    await audit(v, "member.create", { type: "user", id: out.userId }, {
      role: body.role, name: body.name, email: body.email, personNodeId: out.personNodeId, parentOfEdgeId: out.edgeId,
      ...(body.role === "guest" ? { accessExpiresAt: body.accessExpiresAt?.toISOString() } : {}),
    });
    return Response.json({ member: { id: out.userId, personNodeId: out.personNodeId } }, { status: 201 });
  });
}
