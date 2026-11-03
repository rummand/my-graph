import { NextResponse, type NextRequest } from "next/server";
import { getViewer } from "@/lib/auth";
import { hashPassword, passwordProblem } from "@/lib/auth/passwords";
import { clientIp } from "@/lib/auth/rate-limit";
import { completeSignIn, findUserById } from "@/lib/auth/signin";
import { acceptInviteAsNewUser, acceptInviteAsUser, GraphError, inviteEmail, isInviteToken } from "@/lib/graphs";
import { acceptBody, handle, inviteAcceptLimiter, limit, parseJson, setGraphCookie } from "@/lib/graphs/http";

type Ctx = { params: Promise<{ token: string }> };

/**
 * POST: accept an invite.
 *  - Signed in (as the invited email): join the graph and start working in it.
 *  - Not signed in, with { name, password }: make an account for the invited email in a household of its own (with a
 *    Personal graph), join the shared graph, sign in, and open the shared graph.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  return handle(async () => {
    limit(inviteAcceptLimiter, `ip:${clientIp(req.headers)}`);
    const { token } = await ctx.params;
    if (!isInviteToken(token)) throw new GraphError(404, "This invite link doesn't work. Ask for a new one.");
    const body = await parseJson(req, acceptBody);

    const v = await getViewer();
    if (v) {
      const { graphId } = await acceptInviteAsUser(v, token);
      return setGraphCookie(NextResponse.json({ ok: true, graphId, newAccount: false }), graphId);
    }

    if (!body.name || !body.password) {
      throw new GraphError(400, "Enter your name and choose a password to make your account, or sign in first.", {
        fields: [...(!body.name ? [{ key: "name", message: "Enter your name." }] : []), ...(!body.password ? [{ key: "password", message: "Choose a password." }] : [])],
      });
    }
    const email = await inviteEmail(token);
    if (!email) throw new GraphError(404, "This invite link doesn't work. Ask for a new one.");
    const problem = passwordProblem(body.password, { email, name: body.name });
    if (problem) throw new GraphError(400, problem, { fields: [{ key: "password", message: problem }] });

    const { userId, graphId } = await acceptInviteAsNewUser(token, { name: body.name, passwordHash: await hashPassword(body.password) });
    const user = await findUserById(userId);
    if (!user) throw new GraphError(409, "Your account was made, but signing in didn't work. Sign in with your email and password.");
    const res = await completeSignIn(req, user, "password");
    return setGraphCookie(res, graphId);
  });
}
