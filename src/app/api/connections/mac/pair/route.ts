/**
 * POST /api/connections/mac/pair { pairingCode, device? } → { token, connectionId, label }: the helper on the person's
 * Mac trades the one-time code My Graph showed them for its own token (returned once; only its hash is kept). No
 * session: the code is the proof, used once, valid 15 minutes, rate limited per address and overall.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { clientIp } from "@/lib/auth/rate-limit";
import { parseJson } from "@/lib/connectors/http";
import { errorResponse } from "@/lib/connectors/mac/http";
import { acceptPairing } from "@/lib/connectors/mac/server";

const body = z.object({
  pairingCode: z.string().trim().min(10, "Enter the pairing code My Graph showed you.").max(20),
  device: z.string().max(200).optional(),
}).strict();

export async function POST(req: Request) {
  try {
    const input = await parseJson(req, body);
    const out = await acceptPairing(input, clientIp(req.headers));
    return NextResponse.json(out, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
