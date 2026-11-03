import { NextResponse } from "next/server";
import { clientIp } from "@/lib/auth/rate-limit";
import { GraphError, isInviteToken, previewInvite } from "@/lib/graphs";
import { handle, inviteLookupLimiter, limit } from "@/lib/graphs/http";

type Ctx = { params: Promise<{ token: string }> };

/**
 * GET (public): what an invite link is for — the graph's name, who sent it, the email it's for, and whether that
 * email already has an account (so the page can offer "sign in" or "make an account"). Nothing else is revealed.
 */
export async function GET(req: Request, ctx: Ctx) {
  return handle(async () => {
    limit(inviteLookupLimiter, `ip:${clientIp(req.headers)}`);
    const { token } = await ctx.params;
    if (!isInviteToken(token)) throw new GraphError(404, "This invite link doesn't work. Ask for a new one.");
    return NextResponse.json({ invite: await previewInvite(token) }, { headers: { "Cache-Control": "no-store" } });
  });
}
