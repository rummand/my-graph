import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { sessions, users } from "@/db/schema";
import { audit, getSession, isParent, requireUserApi, type Viewer } from "@/lib/auth";
import { AuthError, handle, parseBody, parseParams } from "@/lib/auth/http";
import { canManageRole } from "@/lib/auth/members";
import { approveDeviceBody, idParam } from "@/lib/auth/schemas";
import { clearSessionCookie } from "@/lib/auth/signin";
import { deviceOfSession } from "@/lib/auth/store";

type Ctx = { params: Promise<{ id: string }> };

async function loadTarget(v: Viewer, id: string) {
  const [row] = await db.select({ id: sessions.id, userId: sessions.userId, approved: sessions.approved, role: users.role, householdId: users.householdId, name: users.name })
    .from(sessions).innerJoin(users, eq(users.id, sessions.userId)).where(eq(sessions.id, id)).limit(1);
  if (!row || row.householdId !== v.householdId) throw new AuthError(404, "That session wasn't found. It may already have ended.");
  return row;
}

/** DELETE: end one session — your own, or (parents) a family member's you manage. */
export async function DELETE(_req: Request, ctx: Ctx) {
  return handle(async () => {
    const v = await requireUserApi();
    const { id } = parseParams(await ctx.params, idParam);
    const t = await loadTarget(v, id);
    const own = t.userId === v.id;
    if (!own && !(isParent(v) && canManageRole(v.role, t.role))) throw new AuthError(403, "You can't end that session.");
    await db.delete(sessions).where(eq(sessions.id, id));
    await audit(v, own ? "session.revoke" : t.approved ? "session.revoke_member" : "session.deny", { type: "session", id }, { userId: t.userId, name: t.name });
    const current = await getSession();
    const ended = current.status !== "none" && current.sessionId === id;
    const res = NextResponse.json({ ok: true, signedOutHere: ended });
    return ended ? clearSessionCookie(res) : res;
  });
}

/** POST { approve }: a parent approves (or turns away) a child's or guest's new device. */
export async function POST(req: Request, ctx: Ctx) {
  return handle(async () => {
    const v = await requireUserApi();
    if (!isParent(v)) throw new AuthError(403, "Only parents can approve devices.");
    const { id } = parseParams(await ctx.params, idParam);
    const { approve } = await parseBody(req, approveDeviceBody);
    const t = await loadTarget(v, id);
    if (!canManageRole(v.role, t.role)) throw new AuthError(403, "You can't approve devices for this person.");
    const device = await deviceOfSession(id);
    if (approve) {
      await db.update(sessions).set({ approved: true }).where(eq(sessions.id, id));
      await audit(v, "session.approve", { type: "session", id }, { userId: t.userId, name: t.name });
      if (device) await audit(v, "device.approve", { type: "device", id: `${t.userId}:${device}` }, { userId: t.userId, sessionId: id });
    } else {
      await db.delete(sessions).where(eq(sessions.id, id));
      await audit(v, "session.deny", { type: "session", id }, { userId: t.userId, name: t.name });
      if (device) await audit(v, "device.revoke", { type: "device", id: `${t.userId}:${device}` }, { userId: t.userId, sessionId: id });
    }
    return Response.json({ ok: true });
  });
}
