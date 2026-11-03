import { audit, requireUserApi } from "@/lib/auth";
import { handle, parseBody } from "@/lib/auth/http";
import { passkeyVerifyBody } from "@/lib/auth/schemas";
import { verifyRegistration } from "@/lib/auth/webauthn";

/** POST { challengeId, response, name? } → stores the new passkey. */
export async function POST(req: Request) {
  return handle(async () => {
    const v = await requireUserApi();
    const body = await parseBody(req, passkeyVerifyBody);
    const pk = await verifyRegistration(v, body.challengeId, body.response, req.headers.get("origin"), body.name);
    await audit(v, "passkey.register", { type: "passkey", id: pk.id }, { name: pk.name });
    return Response.json({ passkey: pk }, { status: 201 });
  });
}
