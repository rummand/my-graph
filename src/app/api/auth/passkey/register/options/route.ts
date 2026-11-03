import { requireUserApi } from "@/lib/auth";
import { handle } from "@/lib/auth/http";
import { registrationOptions } from "@/lib/auth/webauthn";

/** POST: options for adding a passkey to the signed-in account. */
export async function POST() {
  return handle(async () => {
    const v = await requireUserApi();
    return Response.json(await registrationOptions(v), { headers: { "Cache-Control": "no-store" } });
  });
}
