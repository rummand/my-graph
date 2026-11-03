import { audit, getSession, requireUserApi } from "@/lib/auth";
import { handle } from "@/lib/auth/http";
import { deleteOtherSessions } from "@/lib/auth/store";

/** DELETE: sign out of every other device. */
export async function DELETE() {
  return handle(async () => {
    const v = await requireUserApi();
    const s = await getSession();
    const n = await deleteOtherSessions(v.id, s.status === "active" ? s.sessionId : undefined);
    await audit(v, "session.revoke_others", { type: "user", id: v.id }, { count: n });
    return Response.json({ ok: true, signedOut: n });
  });
}
