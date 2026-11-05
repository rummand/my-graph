import { z } from "zod";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/auth/constants";
import { cancelDeletion, deletionState, requestDeletion } from "@/lib/export";
import { parseJson, route } from "@/lib/export/http";
import { AuthError } from "@/lib/auth/http";

const body = z.object({ confirm: z.string().max(320, "That's too long.") });

/** GET: whether a deletion is scheduled, and what stands in the way (with who could take things over). */
export const GET = route(async (_req, v) => {
  const s = await deletionState(v.id);
  if (!s) throw new AuthError(404, "This account doesn't exist.");
  return Response.json(s);
});

/**
 * POST { confirm: <your sign-in email> } → 202 { scheduledFor }. Signs you out everywhere; the account is deleted
 * after 7 days unless you sign in again.
 */
export const POST = route(async (req, v) => {
  const { confirm } = await parseJson(req, body);
  const r = await requestDeletion(v.id, confirm);
  (await cookies()).delete(SESSION_COOKIE);
  return Response.json({ scheduledFor: r.scheduledFor }, { status: 202 });
});

/** DELETE: keep the account (cancel a scheduled deletion). */
export const DELETE = route(async (_req, v) => {
  const ok = await cancelDeletion(v.id, "by_person");
  return Response.json({ cancelled: ok });
});
