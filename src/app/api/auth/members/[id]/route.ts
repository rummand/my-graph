import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { nodes, passkeys, provenance, sessions, users } from "@/db/schema";
import { audit, requireParentApi, type Viewer } from "@/lib/auth";
import { AuthError, handle, parseBody, parseParams } from "@/lib/auth/http";
import { canManageRole, emailTaken } from "@/lib/auth/members";
import { hashPassword, passwordProblem } from "@/lib/auth/passwords";
import { idParam, updateMemberBody } from "@/lib/auth/schemas";

type Ctx = { params: Promise<{ id: string }> };

async function managedMember(v: Viewer, id: string) {
  const [m] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!m || m.householdId !== v.householdId) throw new AuthError(404, "That family member wasn't found.");
  if (m.id === v.id) throw new AuthError(400, "Change your own details on the Profile page.");
  if (!canManageRole(v.role, m.role)) {
    throw new AuthError(403, m.role === "owner" ? "Nobody can change the household owner from here." : "Only the household owner can change another parent.");
  }
  return m;
}

/** PATCH: change a member's details, role, guest access, password, or turn off their sign-in (parents only). */
export async function PATCH(req: Request, ctx: Ctx) {
  return handle(async () => {
    const v = await requireParentApi();
    const { id } = parseParams(await ctx.params, idParam);
    const body = await parseBody(req, updateMemberBody);
    const m = await managedMember(v, id);
    const role = body.role ?? m.role;
    if (body.role && !canManageRole(v.role, body.role)) throw new AuthError(403, "Only the household owner can make someone a parent.");
    if (body.email && body.email !== m.email && (await emailTaken(body.email, m.id))) {
      throw new AuthError(409, "Someone already signs in with that email or username.", { fields: [{ key: "email", message: "Already in use." }] });
    }
    if (role === "guest") {
      const exp = body.accessExpiresAt !== undefined ? body.accessExpiresAt : m.accessExpiresAt;
      if (!exp) throw new AuthError(400, "Choose when the guest's access ends.", { fields: [{ key: "accessExpiresAt", message: "Required for guests." }] });
    }
    if (body.password) {
      const problem = passwordProblem(body.password, { email: body.email ?? m.email, name: body.name ?? m.name });
      if (problem) throw new AuthError(400, problem, { fields: [{ key: "password", message: problem }] });
    }

    const patch: Partial<typeof users.$inferInsert> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.email !== undefined) patch.email = body.email;
    if (body.role !== undefined) patch.role = body.role;
    if (body.birthYear !== undefined) patch.birthYear = body.birthYear;
    if (body.accessExpiresAt !== undefined || body.role !== undefined) {
      patch.accessExpiresAt = role === "guest" ? (body.accessExpiresAt !== undefined ? body.accessExpiresAt : m.accessExpiresAt) : null;
    }
    if (body.password) patch.passwordHash = await hashPassword(body.password);
    if (body.disableSignIn) patch.passwordHash = null;

    await db.transaction(async (tx) => {
      if (Object.keys(patch).length) await tx.update(users).set(patch).where(eq(users.id, m.id));
      if (body.password || body.disableSignIn || (body.role && body.role !== m.role)) await tx.delete(sessions).where(eq(sessions.userId, m.id));
      if (body.disableSignIn) await tx.delete(passkeys).where(eq(passkeys.userId, m.id));
      // Keep the member's person node in step with the name and birth year shown here.
      if (m.personNodeId && (body.name !== undefined || body.birthYear !== undefined)) {
        const set: Record<string, unknown> = { updatedAt: new Date() };
        if (body.name !== undefined && body.name !== m.name) set.label = body.name;
        if (body.birthYear !== undefined) set.props = sql`${nodes.props} || ${JSON.stringify({ birthYear: body.birthYear })}::jsonb`;
        const [n] = await tx.update(nodes).set(set).where(and(eq(nodes.id, m.personNodeId), eq(nodes.ownerId, m.id))).returning({ id: nodes.id, graphId: nodes.graphId, householdId: nodes.householdId });
        if (n) {
          await tx.insert(provenance).values({
            householdId: n.householdId, graphId: n.graphId, subjectType: "node", subjectId: n.id, activity: "manual_edit", agentType: "user",
            agentId: v.id, confidence: 1, note: `${v.name} updated this in Family settings`,
          });
        }
      }
    });

    const changed = Object.keys(patch).filter((k) => k !== "passwordHash");
    if (changed.length) await audit(v, "member.update", { type: "user", id: m.id }, { changed, name: body.name ?? m.name, ...(body.role ? { fromRole: m.role, toRole: body.role } : {}) });
    if (body.password) await audit(v, "member.password_reset", { type: "user", id: m.id }, { name: m.name });
    if (body.disableSignIn) await audit(v, "member.sign_in_disabled", { type: "user", id: m.id }, { name: m.name });
    return Response.json({ ok: true });
  });
}

/** DELETE: remove a member and everything in their own brain (parents only; the owner can't be removed). */
export async function DELETE(_req: Request, ctx: Ctx) {
  return handle(async () => {
    const v = await requireParentApi();
    const { id } = parseParams(await ctx.params, idParam);
    const m = await managedMember(v, id);
    await db.delete(users).where(eq(users.id, m.id));
    await audit(v, "member.remove", { type: "user", id: m.id }, { name: m.name, email: m.email, role: m.role });
    return Response.json({ ok: true });
  });
}
