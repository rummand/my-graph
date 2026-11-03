import { handle } from "@/lib/auth/http";
import { authenticationOptions } from "@/lib/auth/webauthn";

/** POST: a fresh challenge for "Sign in with a passkey" (discoverable credentials, no email needed). */
export async function POST() {
  return handle(async () => Response.json(await authenticationOptions(), { headers: { "Cache-Control": "no-store" } }));
}
