import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { nodes, provenance, users } from "@/db/schema";
import { audit, requireUserApi } from "@/lib/auth";
import { AuthError, handle, parseBody } from "@/lib/auth/http";
import { emailTaken } from "@/lib/auth/members";
import { profileBody } from "@/lib/auth/schemas";

/** PATCH { name, email }: update your own profile. Renames your person node too if it still carries your old name. */
export async function PATCH(req: Request) {
  return handle(async () => {
    const v = await requireUserApi();
    const body = await parseBody(req, profileBody);
    if (body.email !== v.email && (await emailTaken(body.email, v.id))) {
      throw new AuthError(409, "Someone in My Graph already signs in with that email or username.", { fields: [{ key: "email", message: "Already in use." }] });
    }
    await db.transaction(async (tx) => {
      const [me] = await tx.update(users).set({ name: body.name, email: body.email }).where(eq(users.id, v.id)).returning({ personNodeId: users.personNodeId });
      // Read from the row: v.personNodeId is only set while working in the family graph.
      const personNodeId = me?.personNodeId ?? null;
      if (body.name !== v.name && personNodeId) {
        const [n] = await tx.update(nodes).set({ label: body.name, updatedAt: new Date() })
          .where(and(eq(nodes.id, personNodeId), eq(nodes.ownerId, v.id), eq(nodes.label, v.name)))
          .returning({ id: nodes.id, graphId: nodes.graphId, householdId: nodes.householdId });
        if (n) {
          await tx.insert(provenance).values({
            householdId: n.householdId, graphId: n.graphId, subjectType: "node", subjectId: n.id, activity: "manual_edit", agentType: "user",
            agentId: v.id, confidence: 1, note: `Renamed from "${v.name}" in Settings`,
          });
        }
      }
    });
    const changed = [body.name !== v.name && "name", body.email !== v.email && "email"].filter(Boolean);
    if (changed.length) await audit(v, "profile.update", { type: "user", id: v.id }, { changed, ...(body.email !== v.email ? { oldEmail: v.email } : {}) });
    return Response.json({ ok: true });
  });
}
